import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface SnapshotFile {
  name: string;
  sha256: string;
  bytes: number;
}

export interface SnapshotMeta {
  id: string;
  createdAt: string;
  label?: string;
  message?: string;
  files: SnapshotFile[];
}

export type DriftStatus = 'added' | 'removed' | 'changed';

export interface DriftChange {
  file: string;
  status: DriftStatus;
}

export interface DriftReport {
  baseline: string | null;
  drifted: boolean;
  changes: DriftChange[];
}

export interface FileDiff {
  file: string;
  status: DriftStatus;
  added: number;
  removed: number;
  lines: string[];
}

export interface RestoreResult {
  restored: string;
  backup: string | null;
  written: string[];
  deleted: string[];
}

const META_FILE = 'meta.json';
const FILES_DIR = 'files';
const HEAD_FILE = 'HEAD';

function hashBytes(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function isBinary(buf: Buffer): boolean {
  return buf.includes(0);
}

function listConfigFiles(configDir: string): string[] {
  if (!fs.existsSync(configDir)) return [];
  return fs
    .readdirSync(configDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

function readConfigFiles(configDir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const name of listConfigFiles(configDir)) {
    out.set(name, fs.readFileSync(path.join(configDir, name)));
  }
  return out;
}

function snapshotFilesDir(snapshotsDir: string, id: string): string {
  return path.join(snapshotsDir, id, FILES_DIR);
}

function readSnapshotFiles(snapshotsDir: string, id: string): Map<string, Buffer> {
  const dir = snapshotFilesDir(snapshotsDir, id);
  const out = new Map<string, Buffer>();
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) out.set(entry.name, fs.readFileSync(path.join(dir, entry.name)));
  }
  return out;
}

function newId(snapshotsDir: string): string {
  const base = new Date().toISOString().replace(/[:.]/g, '-');
  let id = base;
  while (fs.existsSync(path.join(snapshotsDir, id))) {
    id = `${base}-${crypto.randomBytes(2).toString('hex')}`;
  }
  return id;
}

export function readHead(snapshotsDir: string): string | null {
  const file = path.join(snapshotsDir, HEAD_FILE);
  if (!fs.existsSync(file)) return null;
  const id = fs.readFileSync(file, 'utf8').trim();
  if (!id || !fs.existsSync(path.join(snapshotsDir, id, META_FILE))) return null;
  return id;
}

function writeHead(snapshotsDir: string, id: string): void {
  fs.mkdirSync(snapshotsDir, { recursive: true });
  fs.writeFileSync(path.join(snapshotsDir, HEAD_FILE), `${id}\n`, 'utf8');
}

function defaultBaselineId(snapshotsDir: string): string | null {
  const head = readHead(snapshotsDir);
  if (head) return head;
  const snaps = listSnapshots(snapshotsDir);
  return snaps.length ? snaps[snaps.length - 1].id : null;
}

export function listSnapshots(snapshotsDir: string): SnapshotMeta[] {
  if (!fs.existsSync(snapshotsDir)) return [];
  const metas: SnapshotMeta[] = [];
  for (const entry of fs.readdirSync(snapshotsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(snapshotsDir, entry.name, META_FILE);
    if (!fs.existsSync(metaPath)) continue;
    try {
      metas.push(JSON.parse(fs.readFileSync(metaPath, 'utf8')) as SnapshotMeta);
    } catch {
      continue;
    }
  }
  return metas.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function createSnapshot(
  configDir: string,
  snapshotsDir: string,
  opts: { label?: string; message?: string; setHead?: boolean } = {},
): SnapshotMeta {
  const files = readConfigFiles(configDir);
  if (!files.size) throw new Error(`No config files to snapshot in ${configDir}`);
  const id = newId(snapshotsDir);
  const destFiles = snapshotFilesDir(snapshotsDir, id);
  fs.mkdirSync(destFiles, { recursive: true });
  const manifest: SnapshotFile[] = [];
  for (const [name, buf] of files) {
    fs.writeFileSync(path.join(destFiles, name), buf);
    manifest.push({ name, sha256: hashBytes(buf), bytes: buf.length });
  }
  const meta: SnapshotMeta = {
    id,
    createdAt: new Date().toISOString(),
    ...(opts.label ? { label: opts.label } : {}),
    ...(opts.message ? { message: opts.message } : {}),
    files: manifest,
  };
  fs.writeFileSync(path.join(snapshotsDir, id, META_FILE), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  if (opts.setHead !== false) writeHead(snapshotsDir, id);
  return meta;
}

export function resolveSnapshot(
  snapshotsDir: string,
  target: { id?: string; label?: string; latest?: boolean },
): SnapshotMeta {
  const snaps = listSnapshots(snapshotsDir);
  if (!snaps.length) throw new Error('No config snapshots exist yet. Run `taproot config snapshot` first.');
  if (target.id) {
    const found = snaps.find((s) => s.id === target.id);
    if (!found) throw new Error(`Snapshot not found: ${target.id}`);
    return found;
  }
  if (target.label) {
    const matches = snaps.filter((s) => s.label === target.label);
    if (!matches.length) throw new Error(`No snapshot with label: ${target.label}`);
    return matches[matches.length - 1];
  }
  return snaps[snaps.length - 1];
}

function driftBetween(current: Map<string, Buffer>, snapshot: Map<string, Buffer>): DriftChange[] {
  const changes: DriftChange[] = [];
  const names = new Set([...current.keys(), ...snapshot.keys()]);
  for (const name of [...names].sort()) {
    const cur = current.get(name);
    const snap = snapshot.get(name);
    if (cur && !snap) changes.push({ file: name, status: 'added' });
    else if (!cur && snap) changes.push({ file: name, status: 'removed' });
    else if (cur && snap && !cur.equals(snap)) changes.push({ file: name, status: 'changed' });
  }
  return changes;
}

export function statusAgainst(configDir: string, snapshotsDir: string, id?: string): DriftReport {
  const baselineId = id ? resolveSnapshot(snapshotsDir, { id }).id : defaultBaselineId(snapshotsDir);
  if (!baselineId) return { baseline: null, drifted: false, changes: [] };
  const changes = driftBetween(readConfigFiles(configDir), readSnapshotFiles(snapshotsDir, baselineId));
  return { baseline: baselineId, drifted: changes.length > 0, changes };
}

function lineDiff(oldText: string, newText: string): { added: number; removed: number; lines: string[] } {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines: string[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push(`- ${a[i]}`);
      removed++;
      i++;
    } else {
      lines.push(`+ ${b[j]}`);
      added++;
      j++;
    }
  }
  while (i < n) {
    lines.push(`- ${a[i]}`);
    removed++;
    i++;
  }
  while (j < m) {
    lines.push(`+ ${b[j]}`);
    added++;
    j++;
  }
  return { added, removed, lines };
}

export function diffAgainst(configDir: string, snapshotsDir: string, id?: string): { baseline: string; files: FileDiff[] } {
  const baselineId = id ? resolveSnapshot(snapshotsDir, { id }).id : defaultBaselineId(snapshotsDir);
  if (!baselineId) throw new Error('No config snapshots exist yet. Run `taproot config snapshot` first.');
  const current = readConfigFiles(configDir);
  const snapshot = readSnapshotFiles(snapshotsDir, baselineId);
  const files: FileDiff[] = [];
  for (const change of driftBetween(current, snapshot)) {
    const cur = current.get(change.file);
    const snap = snapshot.get(change.file);
    if (change.status === 'changed' && cur && snap && !isBinary(cur) && !isBinary(snap)) {
      const d = lineDiff(snap.toString('utf8'), cur.toString('utf8'));
      files.push({ file: change.file, status: 'changed', added: d.added, removed: d.removed, lines: d.lines });
    } else {
      files.push({ file: change.file, status: change.status, added: 0, removed: 0, lines: [] });
    }
  }
  return { baseline: baselineId, files };
}

export function restoreSnapshot(
  configDir: string,
  snapshotsDir: string,
  target: { id?: string; label?: string; latest?: boolean },
  opts: { backup?: boolean } = {},
): RestoreResult {
  const meta = resolveSnapshot(snapshotsDir, target);
  const backupId = opts.backup === false ? null : createSnapshot(configDir, snapshotsDir, { label: 'pre-restore', message: `before restore of ${meta.id}`, setHead: false }).id;
  const snapshot = readSnapshotFiles(snapshotsDir, meta.id);
  const current = readConfigFiles(configDir);
  fs.mkdirSync(configDir, { recursive: true });
  const written: string[] = [];
  const deleted: string[] = [];
  for (const [name, buf] of snapshot) {
    fs.writeFileSync(path.join(configDir, name), buf);
    written.push(name);
  }
  for (const name of current.keys()) {
    if (!snapshot.has(name)) {
      fs.rmSync(path.join(configDir, name), { force: true });
      deleted.push(name);
    }
  }
  writeHead(snapshotsDir, meta.id);
  return { restored: meta.id, backup: backupId, written: written.sort(), deleted: deleted.sort() };
}

export function pruneSnapshots(snapshotsDir: string, keep: number): string[] {
  const snaps = listSnapshots(snapshotsDir);
  if (snaps.length <= keep) return [];
  const head = readHead(snapshotsDir);
  const recent = new Set(snaps.slice(snaps.length - keep).map((s) => s.id));
  const removed: string[] = [];
  for (const meta of snaps) {
    if (recent.has(meta.id) || meta.id === head) continue;
    fs.rmSync(path.join(snapshotsDir, meta.id), { recursive: true, force: true });
    removed.push(meta.id);
  }
  return removed;
}
