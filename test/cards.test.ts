import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CardStore } from '../src/store/cards.js';
import { RuntimeConfigStore } from '../src/store/runtime-config.js';
import { buildQueryMemory } from '../src/core/query-memory.js';

function tmpDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `taproot-${name}-`));
}

function writeCard(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    [
      'id: orders.by-id',
      'datasource: qa-orders',
      'purpose: Find one order by id inside a bounded creation window.',
      'intent: find order by id',
      'aliases:',
      '  - order lookup',
      'tables:',
      '  - orders',
      'requires:',
      '  must_filter:',
      '    - id',
      '  max_range_days: 7',
      'sql: |',
      '  SELECT id, status, created_at',
      '  FROM orders',
      '  WHERE id = :order_id',
      '    AND created_at >= :from_date',
      '    AND created_at < :to_date',
      '  LIMIT 1',
      'params:',
      '  - name: order_id',
      '    type: number',
      '  - name: from_date',
      '    type: date',
      '  - name: to_date',
      '    type: date',
      'notes:',
      '  - Keep created_at bounded.',
      'indexes_considered:',
      '  - PRIMARY',
      'owners:',
      '  - platform',
      'verified_at: "2026-05-02T00:00:00Z"',
      '',
    ].join('\n'),
  );
}

function runCli(args: string[], env: Record<string, string> = {}) {
  const distCli = path.join(process.cwd(), 'dist', 'index.js');
  return spawnSync(process.execPath, [distCli, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('query cards', () => {
  it('loads cards from repo query roots and matches by intent/table/datasource', () => {
    const root = tmpDir('cards-root');
    writeCard(path.join(root, 'queries', 'qa-orders', 'orders.by-id.yaml'));
    const configFile = path.join(root, 'config.json');
    fs.writeFileSync(configFile, '{}');
    const store = new CardStore({
      repoRoot: root,
      stateRoot: path.join(root, 'state'),
      runtimeConfigStore: new RuntimeConfigStore(configFile),
    });

    expect(store.list()).toHaveLength(1);
    const match = store.match({ datasource: 'qa-orders', intent: 'order lookup', tables: ['orders'] })[0];
    expect(match.card.id).toBe('orders.by-id');
    expect(match.reasons).toContain('datasource');
    expect(match.reasons).toContain('alias');
    expect(match.reasons).toContain('tables');
  });

  it('loads module/service roots and runtime-configured roots', () => {
    const root = tmpDir('cards-roots');
    writeCard(path.join(root, 'modules', 'orders', 'queries', 'orders.by-id.yaml'));
    fs.mkdirSync(path.join(root, 'extra'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'extra', 'orders.by-status.yaml'),
      [
        'id: orders.by-status',
        'datasource: qa-orders',
        'purpose: Find orders by status.',
        'intent: find orders by status',
        'tables: [orders]',
        'sql: SELECT id FROM orders WHERE status = :status LIMIT 10',
        'params: [status]',
        '',
      ].join('\n'),
    );
    const configFile = path.join(root, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ cardRoots: ['extra'] }));
    const store = new CardStore({
      repoRoot: root,
      stateRoot: path.join(root, 'state'),
      runtimeConfigStore: new RuntimeConfigStore(configFile),
    });

    expect(store.list().map((card) => card.id)).toEqual(['orders.by-id', 'orders.by-status']);
  });

  it('injects matched cards and soft requirement warnings into query memory', () => {
    const root = tmpDir('cards-memory');
    writeCard(path.join(root, 'queries', 'orders.by-id.yaml'));
    const configFile = path.join(root, 'config.json');
    fs.writeFileSync(configFile, '{}');
    const store = new CardStore({
      repoRoot: root,
      stateRoot: path.join(root, 'state'),
      runtimeConfigStore: new RuntimeConfigStore(configFile),
    });
    const memory = buildQueryMemory({
      ledgerDir: path.join(root, 'ledger'),
      datasource: 'qa-orders',
      intent: 'find order by id',
      sql: "SELECT id FROM orders WHERE status = 'OPEN'",
      tables: ['orders'],
      cardStore: store,
    });

    expect(memory.matchedCards[0]).toMatchObject({ id: 'orders.by-id' });
    expect(memory.warnings).toContain('card_requires_must_filter:orders.by-id:id');
    expect(memory.warnings).toContain('card_requires_max_range_days_unverified:orders.by-id:7');
  });

  it('supports card CLI list/show/validate and query --card resolution', () => {
    const stateRoot = tmpDir('cards-cli');
    const configDir = path.join(stateRoot, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    writeCard(path.join(stateRoot, 'cards', 'orders.by-id.yaml'));
    fs.writeFileSync(
      path.join(configDir, 'datasources.json'),
      JSON.stringify([
        {
          name: 'qa-orders',
          kind: 'mysql',
          env: 'qa',
          service: 'orders',
          tags: [],
          connection: { host: '127.0.0.1', port: 1, database: 'orders' },
          credentialRef: 'qa:orders',
          connectors: [],
          policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
          updatedAt: new Date().toISOString(),
          confidence: 1,
        },
      ]),
    );
    fs.writeFileSync(path.join(configDir, 'templates.json'), '[]');
    fs.writeFileSync(path.join(configDir, 'deterministic-config.json'), '{}');
    const env = { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key', TAPROOT_FORCE_DIRECT: '1' };

    const list = runCli(['--json', 'card', 'list', '--datasource', 'qa-orders'], env);
    expect(list.status).toBe(0);
    expect(JSON.parse(list.stdout)[0].id).toBe('orders.by-id');

    const show = runCli(['--json', 'card', 'show', 'orders.by-id'], env);
    expect(show.status).toBe(0);
    expect(JSON.parse(show.stdout).purpose).toContain('Find one order');

    const validate = runCli(['--json', 'card', 'validate', path.join(stateRoot, 'cards', 'orders.by-id.yaml')], env);
    expect(validate.status).toBe(0);
    expect(JSON.parse(validate.stdout).card.id).toBe('orders.by-id');

    const query = runCli(['query', '--datasource', 'qa-orders', '--card', 'orders.by-id'], env);
    expect(query.status).toBe(1);
    expect(query.stderr).toContain('Missing --param for :order_id');
  });
});
