import { createRequire } from 'node:module';

interface SqlParser {
  astify: (sql: string) => unknown;
}

type ParserBuild = { Parser: new () => SqlParser };

const require = createRequire(import.meta.url);
let parser: SqlParser | undefined;

const EXPLAIN_ANALYZE_RE = /^\s*(?:explain|describe|desc)\s+(?:format\s*=\s*\S+\s+)?analyze\s+(?:format\s*=\s*\S+\s+)?/i;

function astifySql(sql: string): unknown {
  parser ??= new (require('node-sql-parser/build/mysql.js') as ParserBuild).Parser();
  return parser.astify(sql);
}

export function explainAnalyzeTarget(sql: string): string | undefined {
  const prefix = EXPLAIN_ANALYZE_RE.exec(sql);
  return prefix ? sql.slice(prefix[0].length) : undefined;
}

export function parseExecutedStatements(sql: string): unknown[] | undefined {
  try {
    const ast = astifySql(explainAnalyzeTarget(sql) ?? sql);
    return Array.isArray(ast) ? ast : [ast];
  } catch {
    return undefined;
  }
}
