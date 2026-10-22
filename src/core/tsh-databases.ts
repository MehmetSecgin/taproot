import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

export async function fetchTshDatabases(
  opts: { tshPath?: string } = {},
): Promise<{ ok: boolean; databases: TshDatabase[]; detail: string }> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(opts.tshPath || 'tsh', ['db', 'ls', '--format=json']));
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: unknown };
    return { ok: false, databases: [], detail: (e.stderr || e.stdout || `tsh exit=${e.code}`).trim() };
  }
  try {
    const parsed = JSON.parse(stdout || '[]') as TshDatabase[] | { items?: TshDatabase[] };
    const list = Array.isArray(parsed) ? parsed : parsed.items || [];
    return { ok: true, databases: list, detail: `tsh returned ${list.length} databases` };
  } catch (err) {
    return { ok: false, databases: [], detail: `failed to parse tsh output: ${(err as Error).message}` };
  }
}
