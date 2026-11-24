import { EXPLAIN_KEYWORDS } from './sql-keywords.js';
import { explainAnalyzeTarget, hasSecondStatement, isExplainAnalyze, maskCommentsAndLiterals, parseExecutedStatements } from './sql-parser.js';

export type StatementEffect = 'read' | 'mutate';

const COMMAND_MUTATE_RE = /\b(?:insert|update|delete|alter|drop|truncate|create|replace|grant|revoke|rename)\b/iu;
const LEADING_KEYWORD_RE = /^[\s(]*(?<keyword>[a-z]+)/iu;
const READ_KEYWORDS = new Set(['select', 'with', 'show', ...EXPLAIN_KEYWORDS]);
const SIDE_EFFECT_RE = /\binto\b|:=|\b(?:get_lock|release_lock|release_all_locks|nextval|setval)\b|\bnext\s+value\s+for\b/iu;
const DATA_CHANGE_RE = /\b(?:insert|update|delete|replace)\b/iu;

function leadingKeyword(maskedSql: string): string {
  return LEADING_KEYWORD_RE.exec(maskedSql)?.groups?.keyword?.toLowerCase() ?? '';
}

function isSelectStatement(statement: unknown): boolean {
  return typeof statement === 'object' && statement !== null && 'type' in statement && statement.type === 'select';
}

function classifySelect(sql: string, maskedSql: string, keyword: 'select' | 'with'): StatementEffect {
  const statements = parseExecutedStatements(sql);
  if (statements !== undefined) {
    return statements.every((statement) => isSelectStatement(statement)) ? 'read' : 'mutate';
  }
  return keyword === 'with' && DATA_CHANGE_RE.test(maskedSql) ? 'mutate' : 'read';
}

function classifyNonExplain(sql: string, maskedSql: string, keyword: string): StatementEffect {
  if (keyword === 'select' || keyword === 'with') {
    return classifySelect(sql, maskedSql, keyword);
  }
  return keyword === 'show' ? 'read' : 'mutate';
}

export function classifySql(sql: string): StatementEffect {
  const maskedSql = maskCommentsAndLiterals(sql);
  if (SIDE_EFFECT_RE.test(maskedSql) || hasSecondStatement(sql)) {
    return 'mutate';
  }
  const keyword = leadingKeyword(maskedSql);
  if (!EXPLAIN_KEYWORDS.has(keyword)) {
    return classifyNonExplain(sql, maskedSql, keyword);
  }
  if (!isExplainAnalyze(sql)) {
    return 'read';
  }
  const target = explainAnalyzeTarget(sql);
  return target === undefined ? 'mutate' : classifySql(target);
}

export function classifyCommand(command: string): StatementEffect {
  return COMMAND_MUTATE_RE.test(command) ? 'mutate' : 'read';
}

export function isMultiStatementRead(sql: string): boolean {
  return READ_KEYWORDS.has(leadingKeyword(maskCommentsAndLiterals(sql))) && hasSecondStatement(sql);
}
