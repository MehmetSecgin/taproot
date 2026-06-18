import fs from 'node:fs';
import path from 'node:path';
import type { QueryCard, CardParam, CardRequires } from '../types/cards.js';
import type { QueryResult, SchemaContext } from '../types/core.js';
import { collectReferencedTables } from './schema-context.js';
import { nowIso } from './time.js';
import { stringifyQueryCard } from '../store/cards.js';
import { str } from './strings.js';

export interface PromoteRunInput {
  runsDir: string;
  repoRoot?: string;
  runId: string;
  id?: string;
  purpose?: string;
  intent?: string;
  aliases?: string[];
  owners?: string[];
  outputDir?: string;
  overwrite?: boolean;
  dryRun?: boolean;
}

export interface PromoteRunResult {
  card: QueryCard;
  yaml: string;
  path: string;
  wrote: boolean;
}

function slug(value: string): string {
  return str(value)
    .trim()
    .toLowerCase()
    .replace(/[`'"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'query';
}

function readRunSummary(runsDir: string, runId: string): QueryResult {
  const direct = path.join(runsDir, runId, 'summary.json');
  if (fs.existsSync(direct)) return JSON.parse(fs.readFileSync(direct, 'utf8')) as QueryResult;
  const matches = fs.existsSync(runsDir)
    ? fs.readdirSync(runsDir).filter((entry) => entry === runId || entry.endsWith(runId) || entry.includes(runId))
    : [];
  if (matches.length === 1) {
    const summary = path.join(runsDir, matches[0], 'summary.json');
    if (fs.existsSync(summary)) return JSON.parse(fs.readFileSync(summary, 'utf8')) as QueryResult;
  }
  throw new Error(`Run summary not found for runId '${runId}' in ${runsDir}`);
}

function paramName(base: string, used: Set<string>): string {
  const clean = slug(base).replace(/-/g, '_') || 'param';
  let out = clean;
  let i = 2;
  while (used.has(out)) {
    out = `${clean}_${i}`;
    i += 1;
  }
  used.add(out);
  return out;
}

function bareColumn(value: string): string {
  return str(value).replace(/`/g, '').split('.').pop() || 'param';
}

function parameterizeSql(sql: string): { sql: string; params: CardParam[] } {
  const params: CardParam[] = [];
  const used = new Set<string>();
  let out = str(sql).trim();

  out = out.replace(
    /(\b[\w.`]+\b)\s+between\s+('(?:''|[^'])*'|\b\d{4}-\d{2}-\d{2}\b|\b\d+(?:\.\d+)?\b)\s+and\s+('(?:''|[^'])*'|\b\d{4}-\d{2}-\d{2}\b|\b\d+(?:\.\d+)?\b)/gi,
    (match, column: string) => {
      const from = paramName(`${bareColumn(column)}_from`, used);
      const to = paramName(`${bareColumn(column)}_to`, used);
      params.push({ name: from, required: true }, { name: to, required: true });
      return `${column} BETWEEN :${from} AND :${to}`;
    },
  );

  out = out.replace(/(\b[\w.`]+\b)\s+in\s*\((\s*(?:'[^']*'|\d+(?:\.\d+)?)(?:\s*,\s*(?:'[^']*'|\d+(?:\.\d+)?))*\s*)\)/gi, (match, column: string) => {
    const name = paramName(`${bareColumn(column)}_list`, used);
    params.push({ name, required: true });
    return `${column} IN (:${name})`;
  });

  out = out.replace(/(\b[\w.`]+\b)\s*(=|>=|>|<=|<|<>|!=)\s*('(?:''|[^'])*'|\b\d{4}-\d{2}-\d{2}\b|\b\d+(?:\.\d+)?\b)/g, (match, column: string, op: string) => {
    const suffix = op === '>=' || op === '>' ? '_from' : op === '<=' || op === '<' ? '_to' : '';
    const name = paramName(`${bareColumn(column)}${suffix}`, used);
    params.push({ name, required: true });
    return `${column} ${op} :${name}`;
  });

  return { sql: out, params };
}

function schemaContext(result: QueryResult): SchemaContext {
  return result.meta?.schemaContext || { tables: {} };
}

function indexesConsidered(ctx: SchemaContext): string[] {
  const out = new Set<string>();
  for (const table of Object.values(ctx.tables || {})) {
    for (const index of table.indexes || []) out.add(index.name);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

function requiresFromSchema(ctx: SchemaContext): CardRequires | undefined {
  const partitionPredicates: Record<string, string[]> = {};
  for (const [table, meta] of Object.entries(ctx.tables || {})) {
    const kind = str(meta.partition?.kind).toUpperCase();
    const keys = Array.from(new Set([...(meta.partition?.keys || []), meta.partition?.key || ''].filter(Boolean)));
    if (keys.length && ['RANGE', 'LIST'].includes(kind)) partitionPredicates[table] = keys;
  }
  return Object.keys(partitionPredicates).length ? { partition_predicates: partitionPredicates } : undefined;
}

function defaultPurpose(result: QueryResult, tables: string[]): string {
  const intent = str(result.meta?.queryMemory?.similarPastRuns?.[0]?.reason).trim();
  if (intent) return intent;
  return `Reusable ${String(result.capability || 'query')} query for ${tables.join(', ') || result.datasource}.`;
}

function defaultCardId(result: QueryResult, tables: string[]): string {
  const source = String(result.resolved?.service || result.datasource || 'query');
  const table = tables[0] || 'query';
  return `${slug(source)}.${slug(table)}.${slug(result.result.columns.slice(0, 3).join('-') || 'lookup')}`;
}

export function promoteRunToCard(input: PromoteRunInput): PromoteRunResult {
  const result = readRunSummary(input.runsDir, input.runId);
  if (result.classification !== 'success') {
    throw new Error(`Cannot promote failed run '${input.runId}'. Promote a successful bounded query run.`);
  }
  const rawSql = result.query?.native || '';
  if (!rawSql.trim()) throw new Error(`Run '${input.runId}' has no native SQL to promote.`);
  const ctx = schemaContext(result);
  const tables = Object.keys(ctx.tables || {}).length ? Object.keys(ctx.tables || {}) : collectReferencedTables(rawSql);
  const parameterized = parameterizeSql(rawSql);
  const card: QueryCard = {
    id: input.id || defaultCardId(result, tables),
    datasource: result.datasource,
    kind: str(result.resolved?.engine || result.plugin),
    purpose: input.purpose || defaultPurpose(result, tables),
    intent: input.intent || result.meta?.queryMemory?.similarPastRuns?.[0]?.intent || undefined,
    aliases: input.aliases || [],
    tables,
    requires: requiresFromSchema(ctx),
    forbids: [],
    sql: parameterized.sql,
    params: parameterized.params,
    notes: [`Promoted from run ${input.runId}. Review purpose, params, and safety requirements before relying on this card broadly.`],
    indexes_considered: indexesConsidered(ctx),
    owners: input.owners || [],
    verified_at: nowIso(),
  };
  const repoRoot = input.repoRoot || process.cwd();
  const outputDir = input.outputDir || path.join(repoRoot, 'queries', slug(card.datasource || 'datasource'));
  const outputPath = path.join(outputDir, `${slug(card.id)}.yaml`);
  const yaml = stringifyQueryCard(card);
  if (!input.dryRun) {
    if (fs.existsSync(outputPath) && !input.overwrite) {
      throw new Error(`Query card already exists: ${outputPath}. Re-run with --overwrite to replace it.`);
    }
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputPath, yaml, 'utf8');
  }
  return { card: { ...card, sourcePath: outputPath }, yaml, path: outputPath, wrote: !input.dryRun };
}
