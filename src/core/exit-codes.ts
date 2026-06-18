import { classifyError, exitCodeForClass, EXIT_CODES } from './error-classification.js';
import { str } from './strings.js';

export { EXIT_CODES, exitCodeForClass } from './error-classification.js';

export function classifyExitCode(input: unknown): number {
  const message = str((input as Error)?.message || input).trim();
  if (!message) return EXIT_CODES.GENERAL_ERROR;
  const lower = message.toLowerCase();
  if (/unknown option|required option|too many arguments|missing required argument|invalid argument/.test(lower)) {
    return EXIT_CODES.BAD_INPUT;
  }
  return exitCodeForClass(classifyError(message));
}
