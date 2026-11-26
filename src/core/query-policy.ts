import { SQL_DATASOURCE_KINDS } from '../types/datasource.js';
import type { DatasourceProfile } from '../types/datasource.js';
import type { SchemaContext, SchemaPartition } from '../types/schema-context.js';
import { RUNTIME_CONSTANTS } from './constants.js';
import { badInput, missingPartitionPredicate } from './taproot-error.js';
import { filtersOnPartitionKey, isPrunablePartitionKind, isUnenforcedPartitionKind, partitionKeys, partitionKind } from './partition-keys.js';
import { rangeWarningForPartitionKey } from './partition-range.js';
import { collectPredicateColumns } from './sql-ast-references.js';
import type { PredicateColumnRefs } from './sql-ast-references.js';
import { isSchemaMetadataQuery, parseExecutedStatements } from './sql-parser.js';
import { classifyCommand, classifySql, isMultiStatementRead } from './sql-statement-effect.js';
import { firstNonEmpty } from './text-presence.js';

type PartitionedTable = {
  table: string;
  partition: SchemaPartition;
  predicateColumns: PredicateColumnRefs;
  isScanAllowed: boolean;
};

const PARTITION_GATE_SKIPPED = 'partition_gate_skipped';
const PARTITION_SCAN_BYPASSED = 'partition_scan_bypassed';
const UNKNOWN_PARTITION_KEY = '<unknown>';
const MIN_RANGE_DAYS = 1;

function assertReadAllowed(datasource: DatasourceProfile): void {
  if (!datasource.policy.allowRead) {
    throw new Error('Datasource policy disallows read queries.');
  }
}

function assertMutateAllowed(allowMutate: boolean, datasource: DatasourceProfile): void {
  if (!allowMutate) {
    throw new Error('Mutating query detected. Re-run with --allow-mutate.');
  }
  if (!datasource.policy.allowMutate) {
    throw new Error('Datasource policy disallows mutate queries.');
  }
  if (!datasource.policy.allowedCapabilities.includes('executeMutate')) {
    throw new Error('Datasource capability policy disallows executeMutate.');
  }
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
  const effect = isSql ? classifySql(input.sql) : classifyCommand(input.sql);
  if (effect === 'read') {
    assertReadAllowed(input.datasource);
    return;
  }
  assertMutateAllowed(input.allowMutate, input.datasource);
}

function effectiveMaxRangeDays(requestedDays: number | undefined): number {
  const isRequested = requestedDays !== undefined && requestedDays !== 0 && !Number.isNaN(requestedDays);
  return Math.max(MIN_RANGE_DAYS, isRequested ? requestedDays : RUNTIME_CONSTANTS.query.maxRangeDays);
}

function rangeWarningsForTable(input: {
  sql: string;
  table: string;
  partition: SchemaPartition;
  predicateColumns: PredicateColumnRefs;
  maxRangeDays: number;
}): string[] {
  const { sql, table, partition, predicateColumns, maxRangeDays } = input;
  if (!isPrunablePartitionKind(partition)) {
    return [];
  }
  return partitionKeys(partition)
    .filter((key) => filtersOnPartitionKey(predicateColumns, table, key))
    .map((key) => rangeWarningForPartitionKey({ sql, table, key, maxRangeDays }))
    .filter((warning) => warning !== undefined);
}

export function collectRangeWarnings(input: {
  sql: string;
  schemaContext: SchemaContext;
  maxRangeDays?: number;
}): string[] {
  const tables = Object.entries(input.schemaContext.tables);
  if (isSchemaMetadataQuery(input.sql) || tables.length === 0) {
    return [];
  }
  const maxRangeDays = effectiveMaxRangeDays(input.maxRangeDays);
  const predicateColumns = collectPredicateColumns(input.sql);
  return tables.flatMap(([table, { partition }]) =>
    partition === undefined ? [] : rangeWarningsForTable({ sql: input.sql, table, partition, predicateColumns, maxRangeDays }),
  );
}

function missingPartitionKeys(input: PartitionedTable): string[] {
  const requiredKeys = partitionKeys(input.partition);
  if (requiredKeys.length === 0) {
    return [UNKNOWN_PARTITION_KEY];
  }
  return requiredKeys.filter((key) => !filtersOnPartitionKey(input.predicateColumns, input.table, key));
}

function missingPartitionTarget(partition: SchemaPartition, missingKeys: string[]): string {
  if (partitionKeys(partition).length > 0) {
    return missingKeys.join(', ');
  }
  return firstNonEmpty(partition.expr, partition.kind, 'partition expression') ?? '';
}

function checkPartitionedTable(input: PartitionedTable): string | undefined {
  const { table, partition } = input;
  if (isUnenforcedPartitionKind(partition)) {
    return `partition_pruning_not_enforced:${table}:${partitionKind(partition)}`;
  }
  const missingKeys = isPrunablePartitionKind(partition) ? missingPartitionKeys(input) : [];
  if (missingKeys.length === 0) {
    return undefined;
  }
  if (input.isScanAllowed) {
    return PARTITION_SCAN_BYPASSED;
  }
  throw missingPartitionPredicate(
    `${table} is partitioned by ${missingPartitionTarget(partition, missingKeys)}; add a WHERE/JOIN predicate on the partition column before retrying`,
    { table, partition, missingKeys },
  );
}

export function enforcePartitionPredicate(input: {
  sql: string;
  datasource: DatasourceProfile;
  schemaContext: SchemaContext;
  allowPartitionScan?: boolean;
}): string[] {
  if (!SQL_DATASOURCE_KINDS.has(input.datasource.kind) || isSchemaMetadataQuery(input.sql)) {
    return [];
  }
  if (input.schemaContext.catalog === undefined || parseExecutedStatements(input.sql) === undefined) {
    return [PARTITION_GATE_SKIPPED];
  }
  const predicateColumns = collectPredicateColumns(input.sql);
  const isScanAllowed = input.allowPartitionScan === true || process.env.TAPROOT_ALLOW_PARTITION_SCAN === '1';
  const warnings = Object.entries(input.schemaContext.tables)
    .map(([table, { partition }]) =>
      partition === undefined ? undefined : checkPartitionedTable({ table, partition, predicateColumns, isScanAllowed }),
    )
    .filter((warning) => warning !== undefined);
  return [...new Set(warnings)];
}
