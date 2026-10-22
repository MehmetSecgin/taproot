import { spawnSync } from 'node:child_process';

export interface TshDatabase {
  metadata?: { name?: string };
  // Some `tsh db ls --format=json` shapes flatten this; tolerate both.
  name?: string;
  users?: { allowed?: string[] };
}

export function tshDbName(db: TshDatabase): string {
  return (db.metadata?.name || db.name || '').trim();
}

export function tshDbAllowedUsers(db: TshDatabase): string[] {
  return (db.users?.allowed || []).filter((u) => u && u !== '*');
}

export function fetchTshDatabases(opts: { tshPath?: string } = {}): { ok: boolean; databases: TshDatabase[]; detail: string } {
  const proc = spawnSync(opts.tshPath || 'tsh', ['db', 'ls', '--format=json'], { encoding: 'utf8' });
  if ((proc.status || 0) !== 0) {
    return { ok: false, databases: [], detail: (proc.stderr || proc.stdout || `tsh exit=${proc.status}`).trim() };
  }
  try {
    const parsed = JSON.parse(proc.stdout || '[]') as TshDatabase[] | { items?: TshDatabase[] };
    const list = Array.isArray(parsed) ? parsed : parsed.items || [];
    return { ok: true, databases: list, detail: `tsh returned ${list.length} databases` };
  } catch (err) {
    return { ok: false, databases: [], detail: `failed to parse tsh output: ${(err as Error).message}` };
  }
}
