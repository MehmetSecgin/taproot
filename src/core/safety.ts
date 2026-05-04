import type { DatasourceProfile } from '../types/core.js';
import type { SchemaContext, SchemaPartition } from '../types/core.js';
import { collectPredicateColumns, isSchemaMetadataQuery } from './schema-context.js';

const MUTATE_RE = /\b(insert|update|delete|alter|drop|truncate|create|replace|grant|revoke|rename)\b/i;
const READ_PREFIX_RE = /^\s*(select|show|describe|desc|explain|with)\b/i;

export function classifyMutation(sql: string): 'read' | 'mutate' {
  if (READ_PREFIX_RE.test(sql)) return 'read';
  return MUTATE_RE.test(sql) ? 'mutate' : 'read';
}

export function enforceMutationPolicy(input: {
  sql: string;
  allowMutate: boolean;
  datasource: DatasourceProfile;
}): void {
  const mode = classifyMutation(input.sql);
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

function partitionKind(partition: SchemaPartition): string {
  return String(partition.kind || '').trim().toUpperCase();
}

function isHardPartitionKind(partition: SchemaPartition): boolean {
  return ['RANGE', 'LIST'].includes(partitionKind(partition));
}

function isWarnOnlyPartitionKind(partition: SchemaPartition): boolean {
  return ['HASH', 'KEY'].includes(partitionKind(partition));
}

export function enforcePartitionPredicate(input: {
  sql: string;
  schemaContext: SchemaContext;
  allowPartitionScan?: boolean;
}): string[] {
  const warnings: string[] = [];
  if (isSchemaMetadataQuery(input.sql)) return warnings;
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
    const tableColumns = predicateColumns.byTable.get(table) || predicateColumns.byTable.get(table.split('.').pop() || table) || new Set<string>();
    const missingKeys = requiredKeys.length
      ? requiredKeys.filter((key) => !tableColumns.has(key) && !predicateColumns.bare.has(key))
      : ['<unknown>'];

    if (!missingKeys.length) continue;
    if (allowPartitionScan) {
      if (!warnings.includes('partition_scan_bypassed')) warnings.push('partition_scan_bypassed');
      continue;
    }

    const target = requiredKeys.length ? missingKeys.join(', ') : String(partition.expr || partition.kind || 'partition expression');
    const err = new Error(
      `MISSING_PARTITION_PREDICATE: ${table} is partitioned by ${target}; add a WHERE/JOIN predicate on the partition column before retrying`,
    );
    (err as Error & { code?: string; details?: Record<string, unknown> }).code = 'MISSING_PARTITION_PREDICATE';
    (err as Error & { code?: string; details?: Record<string, unknown> }).details = {
      table,
      partition,
      missingKeys,
      nextAction: requiredKeys.length
        ? `Add a WHERE or JOIN predicate on ${missingKeys.join(', ')} before retrying.`
        : 'TapRoot could not derive the partition key; inspect schemaContext.partition and add the partition predicate before retrying.',
    };
    throw err;
  }

  return warnings;
}
