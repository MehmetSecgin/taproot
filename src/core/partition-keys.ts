import type { SchemaPartition } from '../types/schema-context.js';
import type { PredicateColumnRefs } from './sql-ast-references.js';
import { textUnlessFalsy } from './text-presence.js';

const PRUNABLE_PARTITION_KINDS = new Set(['RANGE', 'LIST']);
const UNENFORCED_PARTITION_KINDS = new Set(['HASH', 'KEY']);

export function partitionKeys(partition: SchemaPartition): string[] {
  const keys = [...(partition.keys ?? []), partition.key ?? ''];
  return [...new Set(keys.filter((key) => key !== ''))];
}

export function filtersOnPartitionKey(predicateColumns: PredicateColumnRefs, table: string, key: string): boolean {
  const column = key.toLowerCase();
  const bareTable = table.toLowerCase().split('.').at(-1) ?? '';
  return predicateColumns.byTable.get(bareTable)?.has(column) === true || predicateColumns.bare.has(column);
}

export function partitionKind(partition: SchemaPartition): string {
  return textUnlessFalsy(partition.kind).trim().toUpperCase();
}

export function isPrunablePartitionKind(partition: SchemaPartition): boolean {
  return PRUNABLE_PARTITION_KINDS.has(partitionKind(partition));
}

export function isUnenforcedPartitionKind(partition: SchemaPartition): boolean {
  return UNENFORCED_PARTITION_KINDS.has(partitionKind(partition));
}
