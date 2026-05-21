import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { QueryCard } from '../types/cards.js';

const MARKER = 'taproot-managed-card';
const MARKER_RE = /^--\s*taproot-managed-card:\s*(.+?)\s*$/m;
const SHA_RE = /^--\s*content-sha1:\s*([0-9a-f]{40})\s*$/m;

export type CardGrouping = 'service' | 'datasource' | 'intent' | 'flat';

export interface CardsSyncOptions {
  projectDir: string;
  rootDir?: string;
  cards: QueryCard[];
  grouping?: CardGrouping;
  force?: boolean;
  adopt?: boolean;
  dryRun?: boolean;
  serviceFor?: (datasource: string) => string | undefined;
}

export type CardAction = 'write' | 'update' | 'move' | 'unchanged' | 'force-overwrite' | 'adopt' | 'skip-drift';

export interface CardSyncEntry {
  id: string;
  action: CardAction;
  relPath: string;
  prevRelPath?: string;
  reason?: string;
}

export interface CardsSyncResult {
  root: string;
  written: CardSyncEntry[];
  unchanged: CardSyncEntry[];
  drifted: CardSyncEntry[];
  pruned: string[];
  foreign: string[];
}

export interface CardsStatusResult {
  root: string;
  matched: string[];
  cardsOnly: string[];
  filesOnly: string[];
  drifted: string[];
  foreign: string[];
}

interface ManagedFile {
  id: string;
  absPath: string;
  relPath: string;
  headerSha: string;
  bodySha: string;
}

export function resolveCardsRoot(projectDir: string, override?: string): string {
  if (override) return path.isAbsolute(override) ? override : path.resolve(projectDir, override);
  return path.join(projectDir, 'taproot-cards');
}

function sha1(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex');
}

function slug(input: string): string {
  return String(input || '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unsorted';
}

export function buildCardBody(card: QueryCard): string {
  return `${card.sql.trimEnd()}\n`;
}

function buildCardHeader(card: QueryCard, bodySha: string): string {
  const lines: string[] = [];
  lines.push(`-- ${MARKER}: ${card.id}`);
  if (card.sourcePath) lines.push(`-- source: ${card.sourcePath}`);
  if (card.datasource) lines.push(`-- datasource: ${card.datasource}`);
  if (card.intent) lines.push(`-- intent: ${card.intent}`);
  if (card.tables?.length) lines.push(`-- tables: ${card.tables.join(', ')}`);
  lines.push(`-- content-sha1: ${bodySha}`);
  lines.push(`-- purpose: ${card.purpose}`);
  if (card.params?.length) {
    lines.push('-- params:');
    for (const p of card.params) {
      const bits = [`--   - ${p.name}`];
      if (p.type) bits.push(`(${p.type})`);
      if (p.required) bits.push('[required]');
      if (p.description) bits.push(`: ${p.description}`);
      lines.push(bits.join(' '));
    }
  }
  if (card.notes?.length) {
    lines.push('-- notes:');
    for (const n of card.notes) lines.push(`--   ${n}`);
  }
  lines.push('-- DO NOT REMOVE THE MARKER ABOVE. Edit the YAML source for permanent changes.');
  lines.push('');
  return lines.join('\n');
}

function parseManagedFile(text: string): { id: string; storedSha: string; body: string } | undefined {
  const m = MARKER_RE.exec(text);
  if (!m) return undefined;
  const shaMatch = SHA_RE.exec(text);
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].startsWith('--')) i++;
  if (i < lines.length && lines[i].trim() === '') i++;
  return { id: m[1], storedSha: shaMatch?.[1] ?? '', body: lines.slice(i).join('\n') };
}

function walkSql(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && ent.name.endsWith('.sql')) out.push(full);
    }
  };
  walk(root);
  return out;
}

function discoverManaged(root: string): { managed: ManagedFile[]; foreign: string[] } {
  const managed: ManagedFile[] = [];
  const foreign: string[] = [];
  for (const abs of walkSql(root)) {
    const text = fs.readFileSync(abs, 'utf8');
    const parsed = parseManagedFile(text);
    const rel = path.relative(root, abs);
    if (!parsed) {
      foreign.push(rel);
      continue;
    }
    managed.push({ id: parsed.id, absPath: abs, relPath: rel, headerSha: parsed.storedSha, bodySha: sha1(parsed.body) });
  }
  return { managed, foreign };
}

function targetRelPath(card: QueryCard, grouping: CardGrouping, serviceFor: (ds: string) => string | undefined): string {
  if (grouping === 'flat') return `${slug(card.id)}.sql`;
  let bucket: string | undefined;
  if (grouping === 'service') bucket = card.datasource ? serviceFor(card.datasource) : undefined;
  else if (grouping === 'datasource') bucket = card.datasource;
  else if (grouping === 'intent') bucket = card.intent;
  return path.join(slug(bucket || 'unsorted'), `${slug(card.id)}.sql`);
}

function stripManagedHeader(text: string): string {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].startsWith('--')) i++;
  if (i < lines.length && lines[i].trim() === '') i++;
  return lines.slice(i).join('\n');
}

function pruneEmptyDirs(root: string): void {
  if (!fs.existsSync(root)) return;
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) walk(path.join(dir, ent.name));
    }
    if (dir !== root) {
      try {
        if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch {
        // ignore
      }
    }
  };
  walk(root);
}

export function syncCardsToProject(opts: CardsSyncOptions): CardsSyncResult {
  const root = resolveCardsRoot(opts.projectDir, opts.rootDir);
  const grouping = opts.grouping ?? 'service';
  const serviceFor = opts.serviceFor ?? (() => undefined);

  const { managed: existing, foreign } = discoverManaged(root);
  const existingById = new Map<string, ManagedFile>();
  for (const e of existing) existingById.set(e.id, e);

  const written: CardSyncEntry[] = [];
  const unchanged: CardSyncEntry[] = [];
  const drifted: CardSyncEntry[] = [];
  const pruned: string[] = [];
  const seen = new Set<string>();

  for (const card of opts.cards) {
    if (seen.has(card.id)) continue;
    seen.add(card.id);

    const relPath = targetRelPath(card, grouping, serviceFor);
    const absPath = path.join(root, relPath);
    const desiredBody = buildCardBody(card);
    const desiredSha = sha1(desiredBody);
    const prior = existingById.get(card.id);

    if (!prior) {
      if (!opts.dryRun) {
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, buildCardHeader(card, desiredSha) + desiredBody);
      }
      written.push({ id: card.id, action: 'write', relPath });
      continue;
    }

    const localEdited = prior.headerSha !== '' && prior.bodySha !== prior.headerSha;
    const cardChanged = prior.headerSha !== desiredSha;
    const moved = prior.absPath !== absPath;

    if (!localEdited && !cardChanged && !moved) {
      unchanged.push({ id: card.id, action: 'unchanged', relPath: prior.relPath });
      continue;
    }

    if (localEdited) {
      if (opts.adopt) {
        if (!opts.dryRun) {
          const body = stripManagedHeader(fs.readFileSync(prior.absPath, 'utf8'));
          fs.writeFileSync(prior.absPath, body);
        }
        written.push({ id: card.id, action: 'adopt', relPath: prior.relPath, reason: 'marker stripped; file kept as foreign' });
        continue;
      }
      if (!opts.force) {
        drifted.push({
          id: card.id,
          action: 'skip-drift',
          relPath: prior.relPath,
          reason: cardChanged ? 'local edits and card changed; --force to overwrite, --adopt to keep edits' : 'local edits without card change; --force to overwrite, --adopt to keep edits',
        });
        continue;
      }
    }

    if (!opts.dryRun) {
      if (moved) {
        try {
          fs.unlinkSync(prior.absPath);
          pruned.push(prior.relPath);
        } catch {
          // ignore
        }
      }
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, buildCardHeader(card, desiredSha) + desiredBody);
    }
    const action: CardAction = localEdited && opts.force ? 'force-overwrite' : moved ? 'move' : 'update';
    written.push({ id: card.id, action, relPath, prevRelPath: moved ? prior.relPath : undefined });
  }

  for (const e of existing) {
    if (seen.has(e.id)) continue;
    if (!opts.dryRun) {
      try {
        fs.unlinkSync(e.absPath);
      } catch {
        // ignore
      }
    }
    pruned.push(e.relPath);
  }

  if (!opts.dryRun) pruneEmptyDirs(root);

  return { root, written, unchanged, drifted, pruned, foreign };
}

export function diffCardsAgainstProject(opts: { projectDir: string; rootDir?: string; cards: QueryCard[] }): CardsStatusResult {
  const root = resolveCardsRoot(opts.projectDir, opts.rootDir);
  const { managed, foreign } = discoverManaged(root);
  const byId = new Map(managed.map((m) => [m.id, m]));
  const matched: string[] = [];
  const cardsOnly: string[] = [];
  const drifted: string[] = [];
  for (const card of opts.cards) {
    const prior = byId.get(card.id);
    if (!prior) {
      cardsOnly.push(card.id);
      continue;
    }
    const desiredSha = sha1(buildCardBody(card));
    const localEdited = prior.headerSha !== '' && prior.bodySha !== prior.headerSha;
    if (localEdited || prior.headerSha !== desiredSha) drifted.push(card.id);
    else matched.push(card.id);
  }
  const ids = new Set(opts.cards.map((c) => c.id));
  const filesOnly = managed.filter((m) => !ids.has(m.id)).map((m) => m.id);
  return {
    root,
    matched: matched.sort(),
    cardsOnly: cardsOnly.sort(),
    filesOnly: filesOnly.sort(),
    drifted: drifted.sort(),
    foreign: foreign.sort(),
  };
}
