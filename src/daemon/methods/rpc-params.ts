export function stringParam(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function stringListParam(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
