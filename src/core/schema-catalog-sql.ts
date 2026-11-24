type CatalogQueries = {
  columns: string;
  indexes: string;
  partitions: string;
};

function escapeSqlString(value: string): string {
  return value.replaceAll('\'', "''");
}

export function catalogQueries(database: string): CatalogQueries {
  const schemaFilter = `WHERE table_schema = '${escapeSqlString(database)}'`;
  return {
    columns: [
      'SELECT table_name AS table_name, column_name AS column_name',
      'FROM information_schema.columns',
      schemaFilter,
      'ORDER BY table_name, ordinal_position',
    ].join(' '),
    indexes: [
      'SELECT table_name, index_name, seq_in_index, column_name, non_unique, index_type',
      'FROM information_schema.statistics',
      schemaFilter,
      'ORDER BY table_name, index_name, seq_in_index',
    ].join(' '),
    partitions: [
      'SELECT table_name, partition_method, partition_expression, subpartition_method, subpartition_expression',
      'FROM information_schema.partitions',
      schemaFilter,
      '  AND partition_name IS NOT NULL',
      'ORDER BY table_name, partition_ordinal_position',
    ].join(' '),
  };
}
