export type SqlDialect = 'mysql' | 'postgres';

export function dialectFromKind(kind: string | undefined): SqlDialect {
  const value = (kind || '').toLowerCase();
  if (value === 'postgres' || value === 'postgresql' || value === 'pg') return 'postgres';
  return 'mysql';
}

export function parserDatabaseOption(dialect: SqlDialect): string {
  return dialect === 'postgres' ? 'PostgresQL' : 'MySQL';
}
