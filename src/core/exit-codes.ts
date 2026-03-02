export const EXIT_CODES = {
  OK: 0,
  GENERAL_ERROR: 1,
  BAD_INPUT: 2,
  CONNECTIVITY: 3,
  AUTH: 4,
  ACCESS_DENIED: 5,
  UNKNOWN_TARGET: 6,
} as const;

function normalizedMessage(input: unknown): string {
  return String((input as Error)?.message || input || '').trim();
}

export function classifyExitCode(input: unknown): number {
  const message = normalizedMessage(input);
  const upper = message.toUpperCase();
  const lower = message.toLowerCase();

  if (/unknown option|required option|too many arguments|missing required argument|invalid argument/.test(lower)) {
    return EXIT_CODES.BAD_INPUT;
  }
  if (upper.startsWith('CONNECTIVITY:')) return EXIT_CODES.CONNECTIVITY;
  if (upper.startsWith('AUTH_EXPIRED:')) return EXIT_CODES.AUTH;
  if (upper.startsWith('ACCESS_DENIED:')) return EXIT_CODES.ACCESS_DENIED;
  if (upper.startsWith('UNKNOWN_TARGET:')) return EXIT_CODES.UNKNOWN_TARGET;
  return EXIT_CODES.GENERAL_ERROR;
}

