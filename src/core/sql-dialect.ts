import { createRequire } from 'node:module';

export type SqlDialect = 'mysql' | 'postgres';

interface SqlParser {
  astify: (sql: string, opts?: { database?: string }) => unknown;
}

type ParserBuild = { Parser: new () => SqlParser };

const require = createRequire(import.meta.url);
const parsers: Partial<Record<SqlDialect, SqlParser>> = {};

function parserFor(dialect: SqlDialect): SqlParser {
  const build = dialect === 'postgres' ? 'node-sql-parser/build/postgresql.js' : 'node-sql-parser/build/mysql.js';
  return (parsers[dialect] ??= new (require(build) as ParserBuild).Parser());
}

export function dialectFromKind(kind: string | undefined): SqlDialect {
  const value = (kind || '').toLowerCase();
  if (value === 'postgres' || value === 'postgresql' || value === 'pg') return 'postgres';
  return 'mysql';
}

export function parserDatabaseOption(dialect: SqlDialect): string {
  return dialect === 'postgres' ? 'PostgresQL' : 'MySQL';
}

export function astifySql(sql: string, dialect: SqlDialect): unknown {
  return parserFor(dialect).astify(sql, { database: parserDatabaseOption(dialect) });
}
