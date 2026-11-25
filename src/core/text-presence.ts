const FALSY_VALUES = new Set<unknown>([undefined, null, false, 0, 0n, '', Number.NaN]);

export function isNonEmpty(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

export function emptyToUndefined(value: string | undefined): string | undefined {
  return isNonEmpty(value) ? value : undefined;
}

export function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  return values.find((value) => isNonEmpty(value));
}

export function nonEmptyOr(value: string | undefined, fallback: string): string {
  return isNonEmpty(value) ? value : fallback;
}

export function isTruthy(value: unknown): boolean {
  return !FALSY_VALUES.has(value);
}

export function textUnlessFalsy(value: unknown): string {
  return isTruthy(value) ? String(value) : '';
}
