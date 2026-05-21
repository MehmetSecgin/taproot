import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCardBody,
  diffCardsAgainstProject,
  resolveCardsRoot,
  syncCardsToProject,
} from '../src/core/idea-cards-sync.js';
import type { QueryCard } from '../src/types/cards.js';

function makeCard(overrides: Partial<QueryCard> = {}): QueryCard {
  return {
    id: 'latest-orders',
    datasource: 'develop-orders',
    purpose: 'Latest orders for a user',
    intent: 'recent-orders',
    aliases: [],
    tables: ['orders'],
    forbids: [],
    sql: 'SELECT * FROM orders WHERE user_id = :user_id ORDER BY id DESC LIMIT 50;',
    params: [{ name: 'user_id', required: true, type: 'bigint' }],
    notes: [],
    indexes_considered: [],
    owners: [],
    ...overrides,
  };
}

describe('idea-cards-sync', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-cards-'));
    fs.mkdirSync(path.join(tmpDir, '.idea'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves cards root under project by default', () => {
    expect(resolveCardsRoot(tmpDir)).toBe(path.join(tmpDir, 'taproot-cards'));
  });

  it('writes new cards into <service>/<id>.sql with marker + sha header', () => {
    const card = makeCard();
    const result = syncCardsToProject({
      projectDir: tmpDir,
      cards: [card],
      serviceFor: () => 'orders-svc',
    });
    expect(result.written).toHaveLength(1);
    expect(result.written[0].action).toBe('write');
    expect(result.written[0].relPath).toBe(path.join('orders-svc', 'latest-orders.sql'));
    const text = fs.readFileSync(path.join(result.root, result.written[0].relPath), 'utf8');
    expect(text).toMatch(/-- taproot-managed-card: latest-orders/);
    expect(text).toMatch(/-- content-sha1: [0-9a-f]{40}/);
    expect(text).toContain('SELECT * FROM orders');
  });

  it('is idempotent: re-sync of unchanged cards reports unchanged', () => {
    const card = makeCard();
    syncCardsToProject({ projectDir: tmpDir, cards: [card], serviceFor: () => 'orders-svc' });
    const second = syncCardsToProject({ projectDir: tmpDir, cards: [card], serviceFor: () => 'orders-svc' });
    expect(second.written).toHaveLength(0);
    expect(second.unchanged.map((u) => u.id)).toEqual(['latest-orders']);
  });

  it('rewrites the file when the card SQL changes', () => {
    const v1 = makeCard();
    syncCardsToProject({ projectDir: tmpDir, cards: [v1], serviceFor: () => 'orders-svc' });
    const v2 = makeCard({ sql: 'SELECT id FROM orders WHERE user_id = :user_id LIMIT 10;' });
    const result = syncCardsToProject({ projectDir: tmpDir, cards: [v2], serviceFor: () => 'orders-svc' });
    expect(result.written.map((w) => w.action)).toEqual(['update']);
    const text = fs.readFileSync(path.join(result.root, result.written[0].relPath), 'utf8');
    expect(text).toContain('LIMIT 10');
    expect(text).not.toContain('LIMIT 50');
  });

  it('detects drift when the user edits a managed file', () => {
    const card = makeCard();
    const first = syncCardsToProject({ projectDir: tmpDir, cards: [card], serviceFor: () => 'orders-svc' });
    const abs = path.join(first.root, first.written[0].relPath);
    fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8') + '\n-- HAND EDIT\n');
    const result = syncCardsToProject({ projectDir: tmpDir, cards: [card], serviceFor: () => 'orders-svc' });
    expect(result.drifted).toHaveLength(1);
    expect(result.drifted[0].id).toBe('latest-orders');
    expect(fs.readFileSync(abs, 'utf8')).toContain('HAND EDIT');
  });

  it('--force overwrites a locally edited managed file', () => {
    const card = makeCard();
    const first = syncCardsToProject({ projectDir: tmpDir, cards: [card], serviceFor: () => 'orders-svc' });
    const abs = path.join(first.root, first.written[0].relPath);
    fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8') + '\n-- HAND EDIT\n');
    const result = syncCardsToProject({ projectDir: tmpDir, cards: [card], serviceFor: () => 'orders-svc', force: true });
    expect(result.written[0].action).toBe('force-overwrite');
    expect(fs.readFileSync(abs, 'utf8')).not.toContain('HAND EDIT');
  });

  it('--adopt strips the marker so the file becomes foreign', () => {
    const card = makeCard();
    const first = syncCardsToProject({ projectDir: tmpDir, cards: [card], serviceFor: () => 'orders-svc' });
    const abs = path.join(first.root, first.written[0].relPath);
    fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8') + '\n-- HAND EDIT\n');
    const result = syncCardsToProject({ projectDir: tmpDir, cards: [card], serviceFor: () => 'orders-svc', adopt: true });
    expect(result.written[0].action).toBe('adopt');
    const after = fs.readFileSync(abs, 'utf8');
    expect(after).not.toMatch(/taproot-managed-card/);
    expect(after).toContain('HAND EDIT');
  });

  it('prunes managed files whose card was removed', () => {
    const a = makeCard();
    const b = makeCard({ id: 'top-users', tables: ['users'], sql: 'SELECT id FROM users LIMIT 10;' });
    syncCardsToProject({ projectDir: tmpDir, cards: [a, b], serviceFor: () => 'orders-svc' });
    const second = syncCardsToProject({ projectDir: tmpDir, cards: [a], serviceFor: () => 'orders-svc' });
    expect(second.pruned.some((p) => p.endsWith('top-users.sql'))).toBe(true);
  });

  it('moves the file when grouping changes', () => {
    const card = makeCard();
    syncCardsToProject({ projectDir: tmpDir, cards: [card], grouping: 'service', serviceFor: () => 'orders-svc' });
    const result = syncCardsToProject({ projectDir: tmpDir, cards: [card], grouping: 'datasource', serviceFor: () => 'orders-svc' });
    expect(result.written[0].action).toBe('move');
    expect(result.written[0].relPath).toBe(path.join('develop-orders', 'latest-orders.sql'));
    expect(result.pruned).toContain(path.join('orders-svc', 'latest-orders.sql'));
  });

  it('leaves foreign .sql files alone', () => {
    const root = path.join(tmpDir, 'taproot-cards');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'scratch.sql'), 'SELECT 1;');
    const result = syncCardsToProject({ projectDir: tmpDir, cards: [makeCard()], serviceFor: () => 'orders-svc' });
    expect(result.foreign).toContain('scratch.sql');
    expect(fs.existsSync(path.join(root, 'scratch.sql'))).toBe(true);
  });

  it('dry-run does not touch the filesystem', () => {
    const card = makeCard();
    const result = syncCardsToProject({ projectDir: tmpDir, cards: [card], serviceFor: () => 'orders-svc', dryRun: true });
    expect(result.written).toHaveLength(1);
    expect(fs.existsSync(path.join(tmpDir, 'taproot-cards'))).toBe(false);
  });

  it('diffCardsAgainstProject reports matched/cardsOnly/filesOnly/drifted', () => {
    const a = makeCard();
    const b = makeCard({ id: 'top-users' });
    syncCardsToProject({ projectDir: tmpDir, cards: [a, b], serviceFor: () => 'orders-svc' });
    const abs = path.join(tmpDir, 'taproot-cards', 'orders-svc', 'top-users.sql');
    fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8') + '\n-- edited\n');
    const diff = diffCardsAgainstProject({
      projectDir: tmpDir,
      cards: [a, makeCard({ id: 'new-card' })],
    });
    expect(diff.matched).toContain('latest-orders');
    expect(diff.cardsOnly).toContain('new-card');
    expect(diff.filesOnly).toContain('top-users');
  });

  it('buildCardBody returns pure SQL deterministically', () => {
    const body = buildCardBody(makeCard());
    expect(body).toContain('SELECT * FROM orders');
    expect(body).not.toMatch(/^--/m);
    expect(body).toBe(buildCardBody(makeCard()));
  });

  it('header carries purpose/params/notes metadata', () => {
    const card = makeCard({ notes: ['use covering index'] });
    const result = syncCardsToProject({ projectDir: tmpDir, cards: [card], serviceFor: () => 'orders-svc' });
    const text = fs.readFileSync(path.join(result.root, result.written[0].relPath), 'utf8');
    expect(text).toMatch(/-- purpose: Latest orders for a user/);
    expect(text).toMatch(/-- params:/);
    expect(text).toMatch(/-- notes:/);
    expect(text).toMatch(/--   use covering index/);
  });
});
