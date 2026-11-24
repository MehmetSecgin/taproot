import type { DoctorCheckCode } from '../types/plugin.js';
import { classifyError } from './error-classification.js';
import type { ErrorClass } from './error-classification.js';
import { errorText } from './error-text.js';
import { textUnlessFalsy } from './text-presence.js';

const EXECUTOR_DOCTOR_CODE_BY_ERROR_CLASS: Partial<Record<ErrorClass, DoctorCheckCode>> = {
  CONNECTIVITY: 'executor_connectivity',
  MISSING_TOOL: 'executor_missing_tool',
  ACCESS_DENIED: 'executor_access_denied',
  AUTH_EXPIRED: 'executor_auth_expired',
  UNKNOWN_TARGET: 'executor_unknown_target',
  QUERY_TIMEOUT: 'executor_query_timeout',
};

export function spawnErrorMessage(error: unknown): string {
  const message = errorText(error);
  const missingBinary = /spawn (?<binary>\S+) ENOENT/u.exec(message)?.groups?.binary;
  return missingBinary === undefined ? message : `MISSING_TOOL: ${missingBinary} is not installed or not on PATH; install it, then retry.`;
}

export function classifyExecutorDoctorCode(message: string): DoctorCheckCode | undefined {
  const normalized = textUnlessFalsy(message).trim();
  if (normalized === '') {
    return undefined;
  }
  if (/missing target\/dbuser\/database/iu.test(normalized)) {
    return 'executor_configuration_missing';
  }
  return EXECUTOR_DOCTOR_CODE_BY_ERROR_CLASS[classifyError(normalized)];
}
