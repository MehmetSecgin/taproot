const ERROR_CLASS_PATTERNS = {
  BAD_INPUT: /^bad_input:/u,
  MISSING_PARTITION_PREDICATE: /missing_partition_predicate/u,
  QUERY_TIMEOUT: /query_timeout|query exceeded timeout|statement timeout|maximum statement execution time exceeded|query execution was interrupted(?!, identified as runaway)/u,
  RESOURCE_LIMIT: /exceeded resource group quota limitation|runaway watch list|identified as runaway query/u,
  MISCONFIGURED_DATASOURCE: /misconfigured_datasource|datasource .*blocks kb-backed execution|conflicts with kb/u,
  DATASOURCE_REFUSED: /datasource_refused/u,
  DATABASE_CONFINED: /database_confined/u,
  DETERMINISTIC_REQUIRED: /deterministic_required|prod requires deterministic/u,
  KB_MISSING: /kb_missing/u,
  UNKNOWN_DATASOURCE: /datasource resolution failed/u,
  AMBIGUOUS_DATASOURCE: /ambiguous_datasource/u,
  AMBIGUOUS_DB_USER: /found several allowed db users/u,
  UNKNOWN_COLUMN: /unknown column|column \S+ does not exist/u,
  AMBIGUOUS_COLUMN: /column \S+ in .+ is ambiguous|column reference \S+ is ambiguous/u,
  UNKNOWN_TABLE: /table \S+ doesn't exist|unknown table|relation \S+ does not exist/u,
  SQL_SYNTAX: /error in your sql syntax|syntax error at or near|syntax error at end of input/u,
  OVERLOADED: /overloaded|queue limit/u,
  ACCESS_DENIED: /access denied|permission denied/u,
  UNKNOWN_DATABASE: /unknown database|does not exist/u,
  MISSING_TOOL: /missing_tool|spawn \S+ enoent|command not found/u,
  CONNECTIVITY: /getaddrinfo (?:eai_again|enotfound [a-z0-9-]+(?:\.[a-z0-9-]+)?(?:\.svc(?:\.cluster\.local)?)?(?![\w.-]))|teleport proxy path unavailable|timeout|timed out|connection refused|econnrefused|enetunreach|ehostunreach|econnreset|eperm .*local|network/u,
  UNKNOWN_TARGET: /getaddrinfo|no such host|target.*not found/u,
  AUTH_EXPIRED: /\b(?:unauthorized|unauthenticated|not logged in|noauth|wrongpass)\b|log ?in again|authentication required|unable to authenticate|(?:session|certificate|token|credentials?) (?:has |have |is )?expired|expired (?:session|certificate|token|credentials?)/u,
  GENERIC: /.*/u,
} as const satisfies Record<string, RegExp>;

export type ErrorClass = keyof typeof ERROR_CLASS_PATTERNS;

export function isErrorClass(value: string): value is ErrorClass {
  return Object.hasOwn(ERROR_CLASS_PATTERNS, value);
}

const ERROR_CLASSES_BY_PRIORITY = Object.keys(ERROR_CLASS_PATTERNS).filter((name) => isErrorClass(name));

export function classifyError(message: string): ErrorClass {
  const explicitClass = /^(?<name>[A-Z_]+):/u.exec(message)?.groups?.name;
  if (explicitClass !== undefined && isErrorClass(explicitClass)) {
    return explicitClass;
  }
  const lowerCased = message.toLowerCase();
  return ERROR_CLASSES_BY_PRIORITY.find((errorClass) => ERROR_CLASS_PATTERNS[errorClass].test(lowerCased)) ?? 'GENERIC';
}

