import { spawnSync } from 'node:child_process';
import type { QueryResult, TelequeryPlugin } from '../../types/core.js';
import { nowIso } from '../../core/time.js';

const NOISE_PREFIXES = [
  'Fetching databases by name',
  'Executing command for',
  'mysql: [Warning] Using a password on the command line interface can be insecure.',
];

function cleanLines(text: string): string[] {
  return text
    .replace(/\r/g, '\n')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !NOISE_PREFIXES.some((p) => s.startsWith(p)));
}

export const teleportMysqlPlugin: TelequeryPlugin = {
  manifest: {
    name: 'teleport-mysql',
    version: '0.1.0',
    kind: 'executor',
    capabilities: ['doctor', 'executeRead'],
    accessMethods: ['tsh'],
    priority: 100,
  },

  async doctor(input) {
    const target = input.datasource.connection.target;
    const dbUser = input.credentials.dbUser || input.credentials.user;
    const dbName = input.datasource.connection.database;
    if (!target || !dbUser || !dbName) {
      return [{ check: 'teleport-mysql doctor', status: 'fail', detail: 'missing target/dbUser/database in datasource+credentials' }];
    }
    const cmd = `tsh db exec 'SELECT 1 AS ok' --db-user ${dbUser} --db-name ${dbName} --dbs ${target} --no-confirm`;
    const proc = spawnSync('/bin/zsh', ['-lc', cmd], { encoding: 'utf8' });
    return [
      {
        check: 'teleport-mysql query',
        status: proc.status === 0 ? 'ok' : 'fail',
        detail: (proc.status === 0 ? proc.stdout : proc.stderr || proc.stdout || '').trim().slice(0, 400) || 'done',
      },
    ];
  },

  async execute(request, creds): Promise<QueryResult> {
    const startedAt = nowIso();
    const start = Date.now();
    const target = request.datasource.connection.target;
    const dbUser = creds.dbUser || creds.user;
    const dbName = request.datasource.connection.database;
    if (!target || !dbUser || !dbName) {
      throw new Error('teleport-mysql requires target, dbUser/user, and database');
    }
    const escapedQuery = request.query.replace(/'/g, "'\\''");
    const cmd = `tsh db exec '${escapedQuery}' --db-user ${dbUser} --db-name ${dbName} --dbs ${target} --no-confirm`;
    const proc = spawnSync('/bin/zsh', ['-lc', cmd], { encoding: 'utf8' });
    if (proc.status !== 0) {
      throw new Error((proc.stderr || proc.stdout || '').trim() || `tsh db exec failed (${proc.status})`);
    }
    const lines = cleanLines(proc.stdout);
    const tabLines = lines.filter((l) => l.includes('\t'));
    if (!tabLines.length && lines.length >= 2) {
      const header = lines[0];
      const rows = lines.slice(1).map((value) => ({ [header]: value }));
      return {
        runId: '',
        datasource: request.datasource.name,
        plugin: 'teleport-mysql',
        capability: request.capability,
        query: { native: request.query },
        result: { columns: [header], rows },
        timings: { startedAt, endedAt: nowIso(), durationMs: Date.now() - start },
        warnings: [],
        classification: 'success',
      };
    }
    if (!tabLines.length) {
      return {
        runId: '',
        datasource: request.datasource.name,
        plugin: 'teleport-mysql',
        capability: request.capability,
        query: { native: request.query },
        result: { columns: [], rows: [] },
        timings: { startedAt, endedAt: nowIso(), durationMs: Date.now() - start },
        warnings: [],
        classification: 'success',
      };
    }
    const headers = tabLines[0].split('\t');
    const rows = tabLines.slice(1).map((line) => {
      const parts = line.split('\t');
      const row: Record<string, unknown> = {};
      headers.forEach((h, i) => {
        row[h] = parts[i] ?? '';
      });
      return row;
    });
    return {
      runId: '',
      datasource: request.datasource.name,
      plugin: 'teleport-mysql',
      capability: request.capability,
      query: { native: request.query },
      result: { columns: headers, rows },
      timings: { startedAt, endedAt: nowIso(), durationMs: Date.now() - start },
      warnings: [],
      classification: 'success',
    };
  },
};
