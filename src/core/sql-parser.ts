import { createRequire } from 'node:module';

interface SqlParser {
  astify: (sql: string) => unknown;
}

type ParserBuild = { Parser: new () => SqlParser };

const require = createRequire(import.meta.url);
let parser: SqlParser | undefined;

export function astifySql(sql: string): unknown {
  parser ??= new (require('node-sql-parser/build/mysql.js') as ParserBuild).Parser();
  return parser.astify(sql);
}
