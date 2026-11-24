const INTEGER_SCALARS = new Set([
  'int32', 'int64', 'uint32', 'uint64',
  'sint32', 'sint64', 'fixed32', 'fixed64',
  'sfixed32', 'sfixed64',
]);
const FLOAT_SCALARS = new Set(['float', 'double']);
const FIXED_PLACEHOLDERS: Record<string, unknown> = {
  bool: false,
  string: '<string>',
  bytes: '<bytes:base64>',
  float: 0,
  double: 0,
};
const INTEGER_TYPE_NAME = /(?:^|u|s)int|fixed/u;
const INTEGER_TEXT = /^-?\d+$/u;

function isIntegerValue(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isFinite(value) && Math.trunc(value) === value;
  }
  if (typeof value === 'bigint') {
    return true;
  }
  return typeof value === 'string' && INTEGER_TEXT.test(value);
}

export function scalarPlaceholder(type: string): unknown {
  if (Object.hasOwn(FIXED_PLACEHOLDERS, type)) {
    return FIXED_PLACEHOLDERS[type];
  }
  return INTEGER_TYPE_NAME.test(type) ? 0 : `<${type}>`;
}

export function isValidScalar(type: string, value: unknown): boolean {
  if (type === 'bool') {
    return typeof value === 'boolean';
  }
  if (type === 'string') {
    return typeof value === 'string';
  }
  if (type === 'bytes') {
    return typeof value === 'string' || value instanceof Uint8Array;
  }
  if (FLOAT_SCALARS.has(type)) {
    return typeof value === 'number' && Number.isFinite(value);
  }
  return INTEGER_SCALARS.has(type) ? isIntegerValue(value) : true;
}
