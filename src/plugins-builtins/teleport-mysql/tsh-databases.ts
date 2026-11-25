import { execFile } from 'node:child_process';
import { firstNonEmpty, nonEmptyOr } from '../../core/text-presence.js';
import { errorText } from '../../core/error-text.js';

type TshDatabase = {
  metadata?: { name?: string };
  name?: string;
  users?: { allowed?: string[] };
};

type TshDatabaseListing = {
  ok: boolean;
  databases: TshDatabase[];
  detail: string;
};

type TshDatabaseWrapper = { items?: TshDatabase[] };

type TshRun = { exitCode: unknown; stdout: string; stderr: string; failed: boolean };

async function runTshDatabaseList(command: string): Promise<TshRun> {
  const run = await new Promise<TshRun>((resolve) => {
    execFile(command, ['db', 'ls', '--format=json'], (failure, stdout, stderr) => {
      resolve({ exitCode: (failure as { code?: unknown } | null)?.code, stdout, stderr, failed: failure !== null });
    });
  });
  return run;
}

export function tshDbName(database: TshDatabase): string {
  const nestedName = database.metadata?.name;
  const flatName = database.name;
  return (firstNonEmpty(nestedName, flatName) ?? '').trim();
}

export function tshDbAllowedUsers(database: TshDatabase): string[] {
  const allowedUsers = database.users?.allowed ?? [];
  return allowedUsers.filter((user) => user !== '' && user !== '*');
}

function parseDatabaseList(stdout: string): TshDatabase[] {
  const parsed = JSON.parse(stdout === '' ? '[]' : stdout) as TshDatabase[] | TshDatabaseWrapper;
  return Array.isArray(parsed) ? parsed : (parsed.items ?? []);
}

export async function fetchTshDatabases(options: { tshPath?: string } = {}): Promise<TshDatabaseListing> {
  const run = await runTshDatabaseList(nonEmptyOr(options.tshPath, 'tsh'));
  if (run.failed) {
    const detail = (firstNonEmpty(run.stderr, run.stdout, `tsh exit=${String(run.exitCode)}`) ?? '').trim();
    return { ok: false, databases: [], detail };
  }
  try {
    const databases = parseDatabaseList(run.stdout);
    return { ok: true, databases, detail: `tsh returned ${databases.length} databases` };
  } catch (error) {
    const reason = errorText(error);
    return { ok: false, databases: [], detail: `failed to parse tsh output: ${reason}` };
  }
}
