import type { QueryMemory, QueryMemoryPastRun } from '../types/core.js';
import { normalizeSqlForLedger, queryFingerprint, readRunsLedgerEntries, type RunsLedgerEntry } from './runs-ledger.js';
import { str } from './strings.js';

export interface BuildQueryMemoryInput {
  ledgerDir: string;
  datasource: string;
  env?: string;
  service?: string;
  reason?: string;
  sql: string;
  tables?: string[];
}

export function resolveReason(value?: string): string {
  return (
    str(value).trim() ||
    str(process.env.TAPROOT_REASON).trim() ||
    str(process.env.TAPROOT_AGENT_TASK).trim()
  );
}

function overlaps(left: string[], right: string[]): boolean {
  if (!left.length || !right.length) return false;
  const set = new Set(left.map((item) => item.toLowerCase()));
  return right.some((item) => set.has(item.toLowerCase()));
}

function toPastRun(row: RunsLedgerEntry, currentDatasource?: string): QueryMemoryPastRun {
  const out: QueryMemoryPastRun = {
    runId: row.runId,
    ts: row.ts,
    outcomeCode: row.outcomeCode,
    tables: row.tables,
  };
  if (row.datasource && row.datasource !== currentDatasource) out.datasource = row.datasource;
  if (row.reason) out.reason = row.reason;
  if (row.errorClass) out.errorClass = row.errorClass;
  if (row.lesson) out.lesson = row.lesson;
  if (typeof row.durationMs === 'number') out.durationMs = row.durationMs;
  if (typeof row.rowCount === 'number') out.rowCount = row.rowCount;
  return out;
}

function recurringFailureHints(rows: RunsLedgerEntry[], tables: string[]): string[] {
  const groups = new Map<string, { count: number; lesson?: string; errorClass: string; tables: string[] }>();
  for (const row of rows) {
    if (!row.errorClass) continue;
    if (tables.length && !overlaps(tables, row.tables)) continue;
    const key = `${row.errorClass}|${row.tables.join(',')}`;
    const prev = groups.get(key) || { count: 0, lesson: row.lesson, errorClass: row.errorClass, tables: row.tables };
    groups.set(key, { ...prev, count: prev.count + 1, lesson: prev.lesson || row.lesson });
  }
  return [...groups.values()]
    .filter((group) => group.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 2)
    .map((group) => group.lesson || `Repeated ${group.errorClass} failures on ${group.tables.join(', ') || 'this query shape'}.`);
}

export function buildQueryMemory(input: BuildQueryMemoryInput): QueryMemory {
  const tables = Array.from(new Set((input.tables || []).map((item) => item.trim()).filter(Boolean))).sort();
  const normalizedSql = normalizeSqlForLedger(input.sql);
  const fingerprint = queryFingerprint({ datasource: input.datasource, normalizedSql });
  const rows = readRunsLedgerEntries(input.ledgerDir, 1000).filter((row) => {
    if (row.datasource === input.datasource) return true;
    if (input.env && input.service && row.env === input.env && row.service === input.service) return true;
    return false;
  });
  const similarPastRuns = rows
    .filter((row) => row.fingerprint === fingerprint || overlaps(tables, row.tables))
    .slice(0, 3)
    .map((row) => toPastRun(row, input.datasource));

  const hints: string[] = [];
  if (!str(input.reason).trim()) {
    // Only nag when the same caller has run multiple queries in the recent ledger without a reason.
    // One-off interactive queries shouldn't trigger the hint.
    const recentNoReason = rows
      .filter((row) => !str(row.reason).trim())
      .filter((row) => row.datasource === input.datasource);
    if (recentNoReason.length >= 2) {
      hints.push('reason_missing: pass --reason or TAPROOT_REASON so future agents can understand why this query ran');
    }
  }
  const sameFingerprintSuccesses = rows.filter((row) => row.fingerprint === fingerprint && row.outcomeCode === 'ok');
  const distinctSessions = new Set(sameFingerprintSuccesses.map((row) => row.sessionId || row.runId));
  if (distinctSessions.size >= 5) {
    hints.push(
      `recurring_shape: this query has succeeded in ${distinctSessions.size} distinct sessions; reuse the run with "taproot run show --run-id <id>" instead of rewriting it`,
    );
  }
  hints.push(...recurringFailureHints(rows, tables));

  const dedupedHints = Array.from(new Set(hints));
  const out: QueryMemory = {};
  if (similarPastRuns.length) out.similarPastRuns = similarPastRuns;
  if (dedupedHints.length) out.hints = dedupedHints;
  return out;
}
