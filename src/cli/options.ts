export function collectRepeated(value: string, previous: string[]): string[] {
  return [...previous, value];
}
