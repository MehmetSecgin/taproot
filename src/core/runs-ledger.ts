import fs from 'node:fs';
import path from 'node:path';
import type { Capability, DatasourceProfile, LedgerRedactionTier, QueryResult } from '../types/core.js';
import { nowIso } from './time.js';
import { str } from './strings.js';

export interface RunsLedgerEntry {
  runId: string;
  sessionId?: string;
  agentId?: string;
  ts: string;
  datasource: string;
  env?: string;
  namespace?: string;
  service?: string;
  intent?: string;
  reason?: string;
  fingerprint: string;
  sql: string;
  normalizedSql: string;
  tables: string[];
  schemaSnapshotRefs: string[];
  capability: Capability;
  outcomeCode: string;
  errorClass?: string;
  lesson?: string;
  durationMs?: number;
  rowCount?: number;
  columns: string[];
}

export interface LedgerWriteInput {
  ledgerDir: string;
  runId: string;
  sessionId?: string;
  datasource: DatasourceProfile;
  intent?: string;
  reason?: string;
  sql: string;
  tables?: string[];
  capability: Capability;
  outcomeCode: string;
  errorClass?: string;
  durationMs?: number;
  rowCount?: number;
  columns?: string[];
  redactionTier: LedgerRedactionTier;
  ts?: string;
}

const ALWAYS_REDACT_PATTERNS: Array<[RegExp, string]> = [
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED_TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]'],
  [/\b(?:\+?\d[\d .()/-]{7,}\d)\b/g, '[REDACTED_PHONE]'],
];

function monthFileName(ts: string): string {
  const m = ts.match(/^(\d{4})-(\d{2})/);
  return `${m ? `${m[1]}-${m[2]}` : 'unknown'}.jsonl`;
}

function stableHash(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function normalizeSqlForLedger(sql: string): string {
  let out = str(sql).trim().replace(/\s+/g, ' ').toLowerCase();
  out = out.replace(/'(?:''|[^'])*'/g, ':str');
  out = out.replace(/"(?:\\"|[^"])*"/g, ':str');
  out = out.replace(/\b\d+\.\d+\b/g, ':num');
  out = out.replace(/\b\d+\b/g, ':num');
  out = out.replace(/\b(true|false)\b/g, ':bool');
  out = out.replace(/\s*([=<>(),])\s*/g, '$1');
  return out.replace(/\s+/g, ' ').trim();
}

export function queryFingerprint(input: { datasource: string; intent?: string; normalizedSql: string }): string {
  const intent = String(input.intent || 'auto').trim().toLowerCase().replace(/\s+/g, ' ');
  return `fp_${stableHash(`${input.datasource}|${intent}|${input.normalizedSql}`)}`;
}

export function redactSqlForLedger(sql: string, tier: LedgerRedactionTier): string {
  let out = str(sql);
  for (const [pattern, replacement] of ALWAYS_REDACT_PATTERNS) out = out.replace(pattern, replacement);
  if (tier === 'raw') return out;
  out = out.replace(/'(?:''|[^'])*'/g, "'[REDACTED]'");
  out = out.replace(/"(?:\\"|[^"])*"/g, '"[REDACTED]"');
  if (tier === 'strict') {
    out = out.replace(/\b\d+\.\d+\b/g, ':num');
    out = out.replace(/\b\d+\b/g, ':num');
  }
  return out;
}

export function lessonForFailure(errorClass: string, tables: string[]): string | undefined {
  if (!errorClass) return undefined;
  if (errorClass === 'MISSING_PARTITION_PREDICATE') {
    const target = tables.length ? ` on ${tables.join(', ')}` : '';
    return `Add required partition predicate(s)${target} before retrying.`;
  }
  if (errorClass === 'QUERY_TIMEOUT') return 'Narrow predicates, reduce result size, or raise timeout only when the slower query is intentional.';
  if (errorClass === 'ACCESS_DENIED' || errorClass === 'AUTH_EXPIRED') return 'Refresh credentials/session instead of retrying the same query shape.';
  return undefined;
}

export function makeRunsLedgerEntry(input: LedgerWriteInput): RunsLedgerEntry {
  const ts = input.ts || nowIso();
  const normalizedSql = normalizeSqlForLedger(input.sql);
  const tables = Array.from(new Set((input.tables || []).map((t) => t.trim()).filter(Boolean))).sort();
  const columns = Array.from(new Set((input.columns || []).map((c) => c.trim()).filter(Boolean))).sort();
  return {
    runId: input.runId,
    sessionId: input.sessionId || undefined,
    agentId: str(process.env.TAPROOT_AGENT_ID).trim() || undefined,
    ts,
    datasource: input.datasource.name,
    env: input.datasource.env || undefined,
    namespace: input.datasource.namespace || undefined,
    service: input.datasource.service || undefined,
    intent: str(input.intent).trim() || undefined,
    reason: str(input.reason).trim() || undefined,
    fingerprint: queryFingerprint({ datasource: input.datasource.name, intent: input.intent, normalizedSql }),
    sql: redactSqlForLedger(input.sql, input.redactionTier),
    normalizedSql,
    tables,
    schemaSnapshotRefs: tables.map((table) => `${input.datasource.name}:${table}`),
    capability: input.capability,
    outcomeCode: input.outcomeCode,
    errorClass: input.errorClass || undefined,
    lesson: lessonForFailure(input.errorClass || '', tables),
    durationMs: input.durationMs,
    rowCount: input.rowCount,
    columns,
  };
}

export function appendRunsLedgerEntry(input: LedgerWriteInput): RunsLedgerEntry | undefined {
  if (str(process.env.TAPROOT_LEDGER).toLowerCase() === 'off') return undefined;
  const entry = makeRunsLedgerEntry(input);
  fs.mkdirSync(input.ledgerDir, { recursive: true });
  fs.appendFileSync(path.join(input.ledgerDir, monthFileName(entry.ts)), `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

export function readRunsLedgerEntries(ledgerDir: string, limit = 500): RunsLedgerEntry[] {
  if (!fs.existsSync(ledgerDir)) return [];
  const files = fs
    .readdirSync(ledgerDir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .slice(-6);
  const rows: RunsLedgerEntry[] = [];
  for (const file of files) {
    const fullPath = path.join(ledgerDir, file);
    const text = fs.readFileSync(fullPath, 'utf8');
    for (const line of text.split(/\n+/)) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as RunsLedgerEntry);
      } catch {
        // Ignore corrupt ledger lines; the ledger is advisory memory, not source-of-truth state.
      }
    }
  }
  return rows.sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, limit);
}

export function ledgerInputFromResult(input: {
  ledgerDir: string;
  result: QueryResult;
  datasource: DatasourceProfile;
  intent?: string;
  reason?: string;
  sql: string;
  tables?: string[];
  redactionTier: LedgerRedactionTier;
  sessionId?: string;
}): LedgerWriteInput {
  return {
    ledgerDir: input.ledgerDir,
    runId: input.result.runId,
    sessionId: input.sessionId,
    datasource: input.datasource,
    intent: input.intent,
    reason: input.reason,
    sql: input.sql,
    tables: input.tables,
    capability: input.result.capability,
    outcomeCode: 'ok',
    durationMs: input.result.timings.durationMs,
    rowCount: input.result.result.rows.length,
    columns: input.result.result.columns,
    redactionTier: input.redactionTier,
  };
}
