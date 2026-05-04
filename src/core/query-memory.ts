import type { QueryMemory, QueryMemoryPastRun } from '../types/core.js';
import type { QueryCard } from '../types/cards.js';
import type { CardStore } from '../store/cards.js';
import { normalizeSqlForLedger, queryFingerprint, readRunsLedgerEntries, type RunsLedgerEntry } from './runs-ledger.js';
import { collectPredicateColumns } from './schema-context.js';

export interface BuildQueryMemoryInput {
  ledgerDir: string;
  datasource: string;
  env?: string;
  service?: string;
  intent?: string;
  reason?: string;
  sql: string;
  tables?: string[];
  cardStore?: CardStore;
  selectedCard?: QueryCard;
}

export function resolveReason(value?: string): string {
  return (
    String(value || '').trim() ||
    String(process.env.TAPROOT_REASON || '').trim() ||
    String(process.env.TAPROOT_AGENT_TASK || '').trim()
  );
}

function overlaps(left: string[], right: string[]): boolean {
  if (!left.length || !right.length) return false;
  const set = new Set(left.map((item) => item.toLowerCase()));
  return right.some((item) => set.has(item.toLowerCase()));
}

function toPastRun(row: RunsLedgerEntry): QueryMemoryPastRun {
  return {
    runId: row.runId,
    ts: row.ts,
    datasource: row.datasource,
    intent: row.intent,
    reason: row.reason,
    fingerprint: row.fingerprint,
    outcomeCode: row.outcomeCode,
    errorClass: row.errorClass,
    lesson: row.lesson,
    tables: row.tables,
    durationMs: row.durationMs,
    rowCount: row.rowCount,
  };
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

function bareColumn(value: string): string {
  return String(value || '').trim().toLowerCase().split('.').pop() || '';
}

function cardRequirementWarnings(card: QueryCard, sql: string): string[] {
  const warnings: string[] = [];
  const requires = card.requires || {};
  const predicates = collectPredicateColumns(sql);
  for (const filter of requires.must_filter || []) {
    const required = bareColumn(filter);
    if (!required) continue;
    const table = String(filter || '').includes('.') ? String(filter).split('.').slice(0, -1).join('.') : '';
    const tableCols = table ? predicates.byTable.get(table) || predicates.byTable.get(table.split('.').pop() || table) : undefined;
    const present = predicates.bare.has(required) || [...predicates.byTable.values()].some((cols) => cols.has(required)) || Boolean(tableCols?.has(required));
    if (!present) warnings.push(`card_requires_must_filter:${card.id}:${filter}`);
  }
  if (requires.max_range_days) {
    const dates = [...String(sql || '').matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)]
      .map((match) => new Date(`${match[1]}T00:00:00Z`).getTime())
      .filter((time) => Number.isFinite(time))
      .sort((a, b) => a - b);
    if (dates.length >= 2) {
      const days = Math.round((dates.at(-1)! - dates[0]) / 86400000);
      if (days > requires.max_range_days) warnings.push(`card_requires_max_range_days:${card.id}:${requires.max_range_days}:actual=${days}`);
    } else {
      warnings.push(`card_requires_max_range_days_unverified:${card.id}:${requires.max_range_days}`);
    }
  }
  return warnings;
}

export function buildQueryMemory(input: BuildQueryMemoryInput): QueryMemory {
  const tables = Array.from(new Set((input.tables || []).map((item) => item.trim()).filter(Boolean))).sort();
  const normalizedSql = normalizeSqlForLedger(input.sql);
  const fingerprint = queryFingerprint({ datasource: input.datasource, intent: input.intent, normalizedSql });
  const rows = readRunsLedgerEntries(input.ledgerDir, 1000).filter((row) => {
    if (row.datasource === input.datasource) return true;
    if (input.env && input.service && row.env === input.env && row.service === input.service) return true;
    return false;
  });
  const similarPastRuns = rows
    .filter((row) => row.fingerprint === fingerprint || overlaps(tables, row.tables) || (input.intent && row.intent === input.intent))
    .slice(0, 5)
    .map(toPastRun);

  const cardMatches = input.cardStore
    ? input.cardStore.match({ datasource: input.datasource, env: input.env, service: input.service, intent: input.intent, tables }).slice(0, 3)
    : [];
  const cards = input.selectedCard
    ? [{ card: input.selectedCard, score: Number.MAX_SAFE_INTEGER, reasons: ['selected'] }, ...cardMatches.filter((match) => match.card.id !== input.selectedCard?.id)]
    : cardMatches;
  const matchedCards = cards.slice(0, 3).map((match) => ({
    id: match.card.id,
    purpose: match.card.purpose,
  }));

  const warnings: string[] = [];
  for (const match of cards.slice(0, 3)) warnings.push(...cardRequirementWarnings(match.card, input.sql));
  const hints: string[] = [];
  if (!String(input.reason || '').trim()) {
    hints.push('reason_missing: pass --reason or TAPROOT_REASON so future agents can understand why this query ran');
  }
  const sameFingerprintSuccesses = rows.filter((row) => row.fingerprint === fingerprint && row.outcomeCode === 'ok');
  const distinctSessions = new Set(sameFingerprintSuccesses.map((row) => row.sessionId || row.runId));
  if (distinctSessions.size >= 5) {
    hints.push('promote_candidate: this query shape has succeeded in at least 5 distinct sessions; consider promoting it to a curated query card');
  }
  hints.push(...recurringFailureHints(rows, tables));

  return {
    matchedCards,
    similarPastRuns,
    warnings,
    hints: Array.from(new Set(hints)),
  };
}

export function renderQueryMemoryTty(memory?: QueryMemory): string {
  if (!memory) return '';
  const lines: string[] = [];
  if (memory.matchedCards.length) {
    lines.push(`matched cards: ${memory.matchedCards.map((card) => card.id).join(', ')}`);
  }
  if (memory.similarPastRuns.length) {
    lines.push(
      `similar runs: ${memory.similarPastRuns
        .slice(0, 3)
        .map((run) => `${run.outcomeCode}${run.reason ? ` (${run.reason})` : ''}`)
        .join(' | ')}`,
    );
  }
  if (memory.warnings.length) lines.push(`warnings: ${memory.warnings.join(' | ')}`);
  if (memory.hints.length) lines.push(`hints: ${memory.hints.join(' | ')}`);
  return lines.length ? `queryMemory:\n${lines.map((line) => `  ${line}`).join('\n')}` : '';
}
