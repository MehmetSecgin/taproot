import type { DoctorCheckCode } from '../types/core.js';
import { str } from './strings.js';

export const EXIT_CODES = {
  OK: 0,
  GENERAL_ERROR: 1,
  BAD_INPUT: 2,
  CONNECTIVITY: 3,
  AUTH: 4,
  ACCESS_DENIED: 5,
  UNKNOWN_TARGET: 6,
  NOT_READY: 7,
} as const;

type ErrorClassDef = {
  exitCode: number;
  match: RegExp;
};

const ERROR_CLASSES = {
  BAD_INPUT: { exitCode: EXIT_CODES.BAD_INPUT, match: /^bad_input:/ },
  MISSING_PARTITION_PREDICATE: { exitCode: EXIT_CODES.BAD_INPUT, match: /missing_partition_predicate/ },
  QUERY_TIMEOUT: { exitCode: EXIT_CODES.GENERAL_ERROR, match: /query_timeout|query exceeded timeout|statement timeout/ },
  MISCONFIGURED_DATASOURCE: {
    exitCode: EXIT_CODES.BAD_INPUT,
    match: /misconfigured_datasource|datasource .*blocks kb-backed execution|conflicts with kb/,
  },
  DETERMINISTIC_REQUIRED: { exitCode: EXIT_CODES.BAD_INPUT, match: /deterministic_required|prod requires deterministic/ },
  DISCOVERY_UNAVAILABLE: { exitCode: EXIT_CODES.BAD_INPUT, match: /discovery_unavailable/ },
  KB_MISSING: { exitCode: EXIT_CODES.NOT_READY, match: /kb_missing/ },
  UNKNOWN_DATASOURCE: { exitCode: EXIT_CODES.BAD_INPUT, match: /datasource resolution failed/ },
  AMBIGUOUS_DB_USER: { exitCode: EXIT_CODES.BAD_INPUT, match: /found several allowed db users/ },
  UNKNOWN_COLUMN: { exitCode: EXIT_CODES.BAD_INPUT, match: /unknown column|column \S+ does not exist/ },
  UNKNOWN_TABLE: { exitCode: EXIT_CODES.BAD_INPUT, match: /table \S+ doesn't exist|unknown table|relation \S+ does not exist/ },
  SQL_SYNTAX: { exitCode: EXIT_CODES.BAD_INPUT, match: /error in your sql syntax|syntax error at or near|syntax error at end of input/ },
  OVERLOADED: { exitCode: EXIT_CODES.GENERAL_ERROR, match: /overloaded|queue limit/ },
  SESSION_BUSY: { exitCode: EXIT_CODES.GENERAL_ERROR, match: /session_busy|session .*active leases/ },
  ACCESS_DENIED: { exitCode: EXIT_CODES.ACCESS_DENIED, match: /access denied|permission denied/ },
  UNKNOWN_DATABASE: { exitCode: EXIT_CODES.GENERAL_ERROR, match: /unknown database|does not exist/ },
  CONNECTIVITY: {
    exitCode: EXIT_CODES.CONNECTIVITY,
    match: /getaddrinfo (?:eai_again|enotfound [a-z0-9-]+(?:\.[a-z0-9-]+)?(?:\.svc(?:\.cluster\.local)?)?(?![\w.-]))|teleport proxy path unavailable|spawn tsh enoent|timeout|timed out|connection refused|econnrefused|enetunreach|ehostunreach|econnreset|eperm .*local|network/,
  },
  UNKNOWN_TARGET: { exitCode: EXIT_CODES.UNKNOWN_TARGET, match: /getaddrinfo|no such host|target.*not found/ },
  AUTH_EXPIRED: { exitCode: EXIT_CODES.AUTH, match: /auth|login|expired|unauthorized/ },
  GENERIC: { exitCode: EXIT_CODES.GENERAL_ERROR, match: /.*/ },
} as const satisfies Record<string, ErrorClassDef>;

export type ErrorClass = keyof typeof ERROR_CLASSES;

export function classifyError(message: string): ErrorClass {
  const prefix = message.match(/^([A-Z_]+):/)?.[1];
  if (prefix && prefix in ERROR_CLASSES) return prefix as ErrorClass;
  const text = message.toLowerCase();
  for (const [cls, def] of Object.entries(ERROR_CLASSES) as Array<[ErrorClass, ErrorClassDef]>) {
    if (def.match.test(text)) return cls;
  }
  return 'GENERIC';
}

export function exitCodeForClass(code: string): number {
  return code in ERROR_CLASSES ? ERROR_CLASSES[code as ErrorClass].exitCode : EXIT_CODES.GENERAL_ERROR;
}

export class TaprootError extends Error {
  readonly code: ErrorClass;
  details?: Record<string, unknown>;
  constructor(code: ErrorClass, message: string, details?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = 'TaprootError';
    if (details) this.details = details;
  }
}

const makeThrower = (cls: ErrorClass) => (message: string, details?: Record<string, unknown>) =>
  new TaprootError(cls, message, details);

export const badInput = makeThrower('BAD_INPUT');
export const missingPartitionPredicate = makeThrower('MISSING_PARTITION_PREDICATE');
export const queryTimeoutErr = makeThrower('QUERY_TIMEOUT');
export const misconfiguredDatasource = makeThrower('MISCONFIGURED_DATASOURCE');
export const deterministicRequired = makeThrower('DETERMINISTIC_REQUIRED');
export const discoveryUnavailable = makeThrower('DISCOVERY_UNAVAILABLE');
export const kbMissing = makeThrower('KB_MISSING');
export const overloaded = makeThrower('OVERLOADED');
export const sessionBusy = makeThrower('SESSION_BUSY');
export const accessDenied = makeThrower('ACCESS_DENIED');
export const connectivity = makeThrower('CONNECTIVITY');

export function classifyExecutorDoctorCode(message: string): DoctorCheckCode | undefined {
  const normalized = str(message).trim();
  if (!normalized) return undefined;
  if (/missing target\/dbuser\/database/i.test(normalized)) return 'executor_configuration_missing';
  switch (classifyError(normalized)) {
    case 'CONNECTIVITY':
      return 'executor_connectivity';
    case 'ACCESS_DENIED':
      return 'executor_access_denied';
    case 'AUTH_EXPIRED':
      return 'executor_auth_expired';
    case 'UNKNOWN_TARGET':
      return 'executor_unknown_target';
    case 'QUERY_TIMEOUT':
      return 'executor_query_timeout';
    default:
      return undefined;
  }
}
