import type { DoctorCheckCode } from '../types/core.js';

export type ErrorClass =
  | 'MISSING_PARTITION_PREDICATE'
  | 'QUERY_TIMEOUT'
  | 'MISCONFIGURED_DATASOURCE'
  | 'DETERMINISTIC_REQUIRED'
  | 'DISCOVERY_UNAVAILABLE'
  | 'OVERLOADED'
  | 'SESSION_BUSY'
  | 'ACCESS_DENIED'
  | 'UNKNOWN_DATABASE'
  | 'UNKNOWN_TARGET'
  | 'CONNECTIVITY'
  | 'AUTH_EXPIRED'
  | 'GENERIC';

export function classifyError(message: string): ErrorClass {
  const text = message.toLowerCase();
  if (/missing_partition_predicate/.test(text)) return 'MISSING_PARTITION_PREDICATE';
  if (/query_timeout|query exceeded timeout|statement timeout/.test(text)) return 'QUERY_TIMEOUT';
  if (/misconfigured_datasource|datasource .*blocks kb-backed execution|conflicts with kb/.test(text)) return 'MISCONFIGURED_DATASOURCE';
  if (/deterministic_required|prod requires deterministic/.test(text)) return 'DETERMINISTIC_REQUIRED';
  if (/discovery_unavailable/.test(text)) return 'DISCOVERY_UNAVAILABLE';
  if (/overloaded|queue limit/.test(text)) return 'OVERLOADED';
  if (/session_busy|session .*active leases/.test(text)) return 'SESSION_BUSY';
  if (/access denied|permission denied/.test(text)) return 'ACCESS_DENIED';
  if (/unknown database|does not exist/.test(text)) return 'UNKNOWN_DATABASE';
  if (/getaddrinfo|no such host|target.*not found/.test(text)) return 'UNKNOWN_TARGET';
  if (/teleport proxy path unavailable|spawn tsh enoent/.test(text)) return 'CONNECTIVITY';
  if (/timeout|timed out|connection refused|econnrefused|enetunreach|ehostunreach|econnreset|eperm .*local|network/.test(text)) return 'CONNECTIVITY';
  if (/auth|login|expired|unauthorized/.test(text)) return 'AUTH_EXPIRED';
  return 'GENERIC';
}

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
