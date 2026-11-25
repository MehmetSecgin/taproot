import type { ErrorClass } from './error-classification.js';

type ErrorDetails = Record<string, unknown>;

export class TaprootError extends Error {
  public readonly code: ErrorClass;
  public details?: ErrorDetails;
  public constructor(code: ErrorClass, message: string, details?: ErrorDetails) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = 'TaprootError';
    if (details) {
      this.details = details;
    }
  }
}
function errorFactory(errorClass: ErrorClass): (message: string, details?: ErrorDetails) => TaprootError {
  return (message, details) => new TaprootError(errorClass, message, details);
}

export const badInput = errorFactory('BAD_INPUT');
export const missingPartitionPredicate = errorFactory('MISSING_PARTITION_PREDICATE');
export const misconfiguredDatasource = errorFactory('MISCONFIGURED_DATASOURCE');
export const databaseConfined = errorFactory('DATABASE_CONFINED');
export const ambiguousDatasource = errorFactory('AMBIGUOUS_DATASOURCE');
export const deterministicRequiredError = errorFactory('DETERMINISTIC_REQUIRED');
export const kbMissing = errorFactory('KB_MISSING');
export const overloaded = errorFactory('OVERLOADED');
export const accessDenied = errorFactory('ACCESS_DENIED');
export const connectivity = errorFactory('CONNECTIVITY');
