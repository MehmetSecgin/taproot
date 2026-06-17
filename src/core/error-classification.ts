import type { DoctorCheckCode } from '../types/core.js';

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

const ERROR_CLASS_DEFS = {
  BAD_INPUT: { exitCode: EXIT_CODES.BAD_INPUT, match: /^bad_input:/ },
  MISSING_PARTITION_PREDICATE: { exitCode: EXIT_CODES.BAD_INPUT, match: /missing_partition_predicate/ },
  REDUNDANT_INTROSPECTION: { exitCode: EXIT_CODES.BAD_INPUT, match: /redundant_introspection/ },
  QUERY_TIMEOUT: { exitCode: EXIT_CODES.GENERAL_ERROR, match: /query_timeout|query exceeded timeout|statement timeout/ },
  MISCONFIGURED_DATASOURCE: {
    exitCode: EXIT_CODES.BAD_INPUT,
    match: /misconfigured_datasource|datasource .*blocks kb-backed execution|conflicts with kb/,
  },
  DETERMINISTIC_REQUIRED: { exitCode: EXIT_CODES.BAD_INPUT, match: /deterministic_required|prod requires deterministic/ },
  DISCOVERY_UNAVAILABLE: { exitCode: EXIT_CODES.BAD_INPUT, match: /discovery_unavailable/ },
  OVERLOADED: { exitCode: EXIT_CODES.GENERAL_ERROR, match: /overloaded|queue limit/ },
  SESSION_BUSY: { exitCode: EXIT_CODES.GENERAL_ERROR, match: /session_busy|session .*active leases/ },
  ACCESS_DENIED: { exitCode: EXIT_CODES.ACCESS_DENIED, match: /access denied|permission denied/ },
  UNKNOWN_DATABASE: { exitCode: EXIT_CODES.GENERAL_ERROR, match: /unknown database|does not exist/ },
  UNKNOWN_TARGET: { exitCode: EXIT_CODES.UNKNOWN_TARGET, match: /getaddrinfo|no such host|target.*not found/ },
  CONNECTIVITY: {
    exitCode: EXIT_CODES.CONNECTIVITY,
    match: /teleport proxy path unavailable|spawn tsh enoent|timeout|timed out|connection refused|econnrefused|enetunreach|ehostunreach|econnreset|eperm .*local|network/,
  },
  AUTH_EXPIRED: { exitCode: EXIT_CODES.AUTH, match: /auth|login|expired|unauthorized/ },
  GENERIC: { exitCode: EXIT_CODES.GENERAL_ERROR, match: /.*/ },
} as const satisfies Record<string, ErrorClassDef>;

export type ErrorClass = keyof typeof ERROR_CLASS_DEFS;

export const ERROR_CLASSES = ERROR_CLASS_DEFS as Record<ErrorClass, ErrorClassDef>;

const CLASSIFY_ORDER: ErrorClass[] = [
  'BAD_INPUT',
  'MISSING_PARTITION_PREDICATE',
  'REDUNDANT_INTROSPECTION',
  'QUERY_TIMEOUT',
  'MISCONFIGURED_DATASOURCE',
  'DETERMINISTIC_REQUIRED',
  'DISCOVERY_UNAVAILABLE',
  'OVERLOADED',
  'SESSION_BUSY',
  'ACCESS_DENIED',
  'UNKNOWN_DATABASE',
  'UNKNOWN_TARGET',
  'CONNECTIVITY',
  'AUTH_EXPIRED',
];

export function classifyError(message: string): ErrorClass {
  const text = message.toLowerCase();
  for (const cls of CLASSIFY_ORDER) {
    if (ERROR_CLASSES[cls].match.test(text)) return cls;
  }
  return 'GENERIC';
}

export function exitCodeFor(cls: ErrorClass): number {
  return ERROR_CLASSES[cls].exitCode;
}

export function exitCodeForClass(code: string): number {
  return code in ERROR_CLASSES ? exitCodeFor(code as ErrorClass) : EXIT_CODES.GENERAL_ERROR;
}

export class TaprootError extends Error {
  readonly cls: ErrorClass;
  details?: Record<string, unknown>;
  constructor(cls: ErrorClass, message: string, details?: Record<string, unknown>) {
    super(`${cls}: ${message}`);
    this.cls = cls;
    this.name = 'TaprootError';
    if (details) this.details = details;
  }
  get code(): ErrorClass {
    return this.cls;
  }
}

const makeThrower = (cls: ErrorClass) => (message: string, details?: Record<string, unknown>) =>
  new TaprootError(cls, message, details);

export const badInput = makeThrower('BAD_INPUT');
export const missingPartitionPredicate = makeThrower('MISSING_PARTITION_PREDICATE');
export const redundantIntrospection = makeThrower('REDUNDANT_INTROSPECTION');
export const queryTimeoutErr = makeThrower('QUERY_TIMEOUT');
export const misconfiguredDatasource = makeThrower('MISCONFIGURED_DATASOURCE');
export const deterministicRequired = makeThrower('DETERMINISTIC_REQUIRED');
export const discoveryUnavailable = makeThrower('DISCOVERY_UNAVAILABLE');
export const overloaded = makeThrower('OVERLOADED');
export const sessionBusy = makeThrower('SESSION_BUSY');
export const accessDenied = makeThrower('ACCESS_DENIED');
export const unknownDatabase = makeThrower('UNKNOWN_DATABASE');
export const unknownTarget = makeThrower('UNKNOWN_TARGET');
export const connectivity = makeThrower('CONNECTIVITY');
export const authExpired = makeThrower('AUTH_EXPIRED');

export function classifyExecutorDoctorCode(message: string): DoctorCheckCode | undefined {
  const normalized = String(message || '').trim();
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
