import mysqlParserPkg from 'node-sql-parser/build/mysql.js';
import postgresParserPkg from 'node-sql-parser/build/postgresql.js';

export type SqlDialect = 'mysql' | 'postgres';

interface SqlParser {
  astify: (sql: string, opts?: { database?: string }) => unknown;
}

type ParserBuild = { Parser: new () => SqlParser };

const parsers: Record<SqlDialect, SqlParser> = {
  mysql: new (mysqlParserPkg as unknown as ParserBuild).Parser(),
  postgres: new (postgresParserPkg as unknown as ParserBuild).Parser(),
};

export function dialectFromKind(kind: string | undefined): SqlDialect {
  const value = (kind || '').toLowerCase();
  if (value === 'postgres' || value === 'postgresql' || value === 'pg') return 'postgres';
  return 'mysql';
}

export function parserDatabaseOption(dialect: SqlDialect): string {
  return dialect === 'postgres' ? 'PostgresQL' : 'MySQL';
}

export function astifySql(sql: string, dialect: SqlDialect): unknown {
  return parsers[dialect].astify(sql, { database: parserDatabaseOption(dialect) });
}
