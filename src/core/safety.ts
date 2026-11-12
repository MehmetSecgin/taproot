import { SQL_DATASOURCE_KINDS } from '../types/core.js';
import type { DatasourceProfile } from '../types/core.js';
import type { SchemaContext, SchemaPartition } from '../types/core.js';
import { RUNTIME_CONSTANTS } from './constants.js';
import { badInput, missingPartitionPredicate } from './error-classification.js';
import { collectPredicateColumns, isSchemaMetadataQuery, type PredicateColumnRefs } from './schema-context.js';
import { explainAnalyzeTarget, hasSecondStatement, isExplainAnalyze, maskCommentsAndLiterals, parseExecutedStatements } from './sql-parser.js';
import { str } from './strings.js';

type QueryMode = 'read' | 'mutate';

const COMMAND_MUTATE_RE = /\b(insert|update|delete|alter|drop|truncate|create|replace|grant|revoke|rename)\b/i;
const LEADING_KEYWORD_RE = /^[\s(]*([a-z]+)/i;
const EXPLAIN_KEYWORDS = new Set(['explain', 'describe', 'desc']);
const READ_KEYWORDS = new Set(['select', 'with', 'show', ...EXPLAIN_KEYWORDS]);
const SIDE_EFFECT_RE = /\binto\b|:=|\b(get_lock|release_lock|release_all_locks|nextval|setval)\b|\bnext\s+value\s+for\b/i;
const DATA_CHANGE_RE = /\b(insert|update|delete|replace)\b/i;

export function classifySql(sql: string): QueryMode {
  const code = maskCommentsAndLiterals(sql);
  if (SIDE_EFFECT_RE.test(code) || hasSecondStatement(code)) return 'mutate';
  const keyword = leadingKeyword(code);
  if (keyword === 'select' || keyword === 'with') return classifySelect(code, keyword);
  if (keyword === 'show') return 'read';
  if (EXPLAIN_KEYWORDS.has(keyword)) return classifyExplain(code);
  return 'mutate';
}

function leadingKeyword(code: string): string {
  return LEADING_KEYWORD_RE.exec(code)?.[1].toLowerCase() ?? '';
}

function isMultiStatementRead(sql: string): boolean {
  const code = maskCommentsAndLiterals(sql);
  return READ_KEYWORDS.has(leadingKeyword(code)) && hasSecondStatement(code);
}

function isSelect(statement: unknown): boolean {
  return (statement as { type?: unknown }).type === 'select';
}

function classifySelect(code: string, keyword: 'select' | 'with'): QueryMode {
  const statements = parseExecutedStatements(code);
  if (statements) return statements.every(isSelect) ? 'read' : 'mutate';
  return keyword === 'with' && DATA_CHANGE_RE.test(code) ? 'mutate' : 'read';
}

function classifyExplain(code: string): QueryMode {
  if (!isExplainAnalyze(code)) return 'read';
  const target = explainAnalyzeTarget(code);
  return target === undefined ? 'mutate' : classifySql(target);
}

function classifyCommand(command: string): QueryMode {
  return COMMAND_MUTATE_RE.test(command) ? 'mutate' : 'read';
}

export function enforceMutationPolicy(input: {
  sql: string;
  allowMutate: boolean;
  datasource: DatasourceProfile;
}): void {
  const isSql = SQL_DATASOURCE_KINDS.has(input.datasource.kind);
  if (isSql && isMultiStatementRead(input.sql)) {
    throw badInput('send one SQL statement per query. Run each statement in its own taproot query call.');
  }
  const mode = isSql ? classifySql(input.sql) : classifyCommand(input.sql);
  if (mode === 'read') {
    if (!input.datasource.policy.allowRead) {
      throw new Error('Datasource policy disallows read queries.');
    }
    return;
  }
  if (!input.allowMutate) {
    throw new Error('Mutating query detected. Re-run with --allow-mutate.');
  }
  if (!input.datasource.policy.allowMutate) {
    throw new Error('Datasource policy disallows mutate queries.');
  }
  if (!input.datasource.policy.allowedCapabilities.includes('executeMutate')) {
    throw new Error('Datasource capability policy disallows executeMutate.');
  }
}

function partitionKeys(partition: SchemaPartition): string[] {
  return Array.from(new Set([...(partition.keys || []), partition.key || ''].filter(Boolean)));
}

function filtersOn(predicateColumns: PredicateColumnRefs, table: string, key: string): boolean {
  const column = key.toLowerCase();
  const bareTable = table.toLowerCase().split('.').pop() || '';
  return Boolean(predicateColumns.byTable.get(bareTable)?.has(column)) || predicateColumns.bare.has(column);
}

function partitionKind(partition: SchemaPartition): string {
  return str(partition.kind).trim().toUpperCase();
}

function isHardPartitionKind(partition: SchemaPartition): boolean {
  return ['RANGE', 'LIST'].includes(partitionKind(partition));
}

function isWarnOnlyPartitionKind(partition: SchemaPartition): boolean {
  return ['HASH', 'KEY'].includes(partitionKind(partition));
}

const DATE_LITERAL_RE = /'(\d{4}-\d{2}-\d{2})(?:[ T][\d:.]+)?'/g;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dateLiteralsMs(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(DATE_LITERAL_RE)) {
    const time = Date.parse(`${match[1]}T00:00:00Z`);
    if (Number.isFinite(time)) out.push(time);
  }
  return out;
}

function sortedDateLiteralsForColumn(sql: string, key: string): number[] {
  const column = escapeRegex(key);
  const predicate = new RegExp(
    `\\b${column}\\b\\s*(?:between\\s+('[^']*')\\s+and\\s+('[^']*')|in\\s*\\(([^)]*)\\)|(?:<=|>=|<|>|=)\\s*('[^']*'))`,
    'gi',
  );
  const out: number[] = [];
  for (const match of str(sql).matchAll(predicate)) {
    for (const operand of match.slice(1)) {
      if (operand) out.push(...dateLiteralsMs(operand));
    }
  }
  return out.sort((a, b) => a - b);
}

function hasBoundedPredicate(sql: string, key: string): boolean {
  return new RegExp(`\\b${escapeRegex(key)}\\b\\s*(<=?|=|between\\b|in\\b)`, 'i').test(str(sql));
}

export function collectRangeWarnings(input: {
  sql: string;
  schemaContext: SchemaContext;
  maxRangeDays?: number;
}): string[] {
  const warnings: string[] = [];
  if (isSchemaMetadataQuery(input.sql)) return warnings;
  const tables = input.schemaContext.tables || {};
  if (!Object.keys(tables).length) return warnings;

  const maxRangeDays = Math.max(1, Number(input.maxRangeDays || RUNTIME_CONSTANTS.query.maxRangeDays));
  const predicateColumns = collectPredicateColumns(input.sql);

  for (const [table, ctx] of Object.entries(tables)) {
    const partition = ctx.partition;
    if (!partition || !isHardPartitionKind(partition)) continue;

    for (const key of partitionKeys(partition)) {
      if (!filtersOn(predicateColumns, table, key)) continue;
      const literals = sortedDateLiteralsForColumn(input.sql, key);
      if (!literals.length) {
        warnings.push(`range_unverified:${table}.${key}`);
        continue;
      }
      if (!hasBoundedPredicate(input.sql, key)) {
        warnings.push(`unbounded_range:${table}.${key}`);
        continue;
      }
      const spanDays = Math.round((literals[literals.length - 1] - literals[0]) / 86_400_000);
      if (spanDays > maxRangeDays) {
        warnings.push(`wide_range:${table}.${key}:actual=${spanDays}:max=${maxRangeDays}`);
      }
    }
  }

  return warnings;
}

export function enforcePartitionPredicate(input: {
  sql: string;
  datasource: DatasourceProfile;
  schemaContext: SchemaContext;
  allowPartitionScan?: boolean;
}): string[] {
  const warnings: string[] = [];
  if (!SQL_DATASOURCE_KINDS.has(input.datasource.kind) || isSchemaMetadataQuery(input.sql)) return warnings;
  if (!input.schemaContext.catalog || !parseExecutedStatements(input.sql)) return ['partition_gate_skipped'];
  const tables = input.schemaContext.tables || {};
  if (!Object.keys(tables).length) return warnings;

  const allowByEnv = process.env.TAPROOT_ALLOW_PARTITION_SCAN === '1';
  const allowPartitionScan = Boolean(input.allowPartitionScan || allowByEnv);
  const predicateColumns = collectPredicateColumns(input.sql);

  for (const [table, ctx] of Object.entries(tables)) {
    const partition = ctx.partition;
    if (!partition) continue;
    if (isWarnOnlyPartitionKind(partition)) {
      warnings.push(`partition_pruning_not_enforced:${table}:${partitionKind(partition)}`);
      continue;
    }
    if (!isHardPartitionKind(partition)) continue;

    const requiredKeys = partitionKeys(partition);
    const missingKeys = requiredKeys.length
      ? requiredKeys.filter((key) => !filtersOn(predicateColumns, table, key))
      : ['<unknown>'];

    if (!missingKeys.length) continue;
    if (allowPartitionScan) {
      if (!warnings.includes('partition_scan_bypassed')) warnings.push('partition_scan_bypassed');
      continue;
    }

    const target = requiredKeys.length ? missingKeys.join(', ') : String(partition.expr || partition.kind || 'partition expression');
    throw missingPartitionPredicate(
      `${table} is partitioned by ${target}; add a WHERE/JOIN predicate on the partition column before retrying`,
      {
        table,
        partition,
        missingKeys,
      },
    );
  }

  return warnings;
}
