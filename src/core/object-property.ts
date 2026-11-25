export function propertyOf(value: unknown, property: string): unknown {
  return typeof value === 'object' && value !== null && property in value ? Reflect.get(value, property) : undefined;
}
