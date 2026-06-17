import type { ProtobufRoot } from './proto-loader.js';
import { suggestNames } from './grpc-introspect.js';

interface PbField {
  name: string;
  jsonName?: string;
  type: string;
  repeated?: boolean;
  rule?: string;
  map?: boolean;
  keyType?: string;
  resolvedType?: unknown;
  resolve?: () => void;
}

interface PbType {
  fullName: string;
  name: string;
  fieldsArray: PbField[];
  resolve?: () => void;
}

interface PbEnum {
  fullName: string;
  values: Record<string, number>;
}

export interface ValidationError {
  field: string;
  expected: string;
  message: string;
}

export interface ValidateOptions {
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 8;

const INT_SCALARS = new Set([
  'int32', 'int64', 'uint32', 'uint64',
  'sint32', 'sint64', 'fixed32', 'fixed64',
  'sfixed32', 'sfixed64',
]);
const FLOAT_SCALARS = new Set(['float', 'double']);

function isType(node: unknown): node is PbType {
  return !!node && typeof node === 'object' && Array.isArray((node as PbType).fieldsArray);
}

function isEnum(node: unknown): node is PbEnum {
  if (!node || typeof node !== 'object') return false;
  const obj = node as Record<string, unknown>;
  return !!obj.values && !Array.isArray((obj as Record<string, unknown>).fieldsArray);
}

function stripLeadingDot(name: string): string {
  return name.startsWith('.') ? name.slice(1) : name;
}

function scalarOk(type: string, value: unknown): boolean {
  if (type === 'bool') return typeof value === 'boolean';
  if (type === 'string') return typeof value === 'string';
  if (type === 'bytes') return typeof value === 'string' || value instanceof Uint8Array;
  if (FLOAT_SCALARS.has(type)) return typeof value === 'number' && Number.isFinite(value);
  if (INT_SCALARS.has(type)) {
    if (typeof value === 'number') return Number.isFinite(value) && Math.trunc(value) === value;
    if (typeof value === 'bigint') return true;
    if (typeof value === 'string') return /^-?\d+$/.test(value);
    return false;
  }
  return true;
}

function knownNamesFor(fields: PbField[]): string[] {
  const out: string[] = [];
  for (const f of fields) {
    out.push(f.name);
    if (f.jsonName && f.jsonName !== f.name) out.push(f.jsonName);
  }
  return out;
}

function resolveType(t: PbType | undefined): void {
  if (t && typeof t.resolve === 'function') {
    try { t.resolve(); } catch { /* ignore */ }
  }
}

export function validateGrpcRequest(
  root: ProtobufRoot,
  typeName: string,
  payload: unknown,
  opts: ValidateOptions = {},
): ValidationError | null {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;

  function walkMessage(typeFq: string, value: unknown, path: string, depth: number): ValidationError | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object' || Array.isArray(value)) {
      return {
        field: path || typeFq,
        expected: `message:${typeFq}`,
        message: `expected object at ${path || typeFq}, got ${Array.isArray(value) ? 'array' : typeof value}`,
      };
    }
    let resolved: unknown = null;
    try { resolved = root.lookup(typeFq); } catch { resolved = null; }
    if (!isType(resolved)) return null;
    resolveType(resolved);
    const fields = resolved.fieldsArray;
    const fieldByName = new Map<string, PbField>();
    for (const f of fields) {
      fieldByName.set(f.name, f);
      if (f.jsonName && f.jsonName !== f.name) fieldByName.set(f.jsonName, f);
    }
    const obj = value as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      if (fieldByName.has(k)) continue;
      const here = path ? `${path}.${k}` : k;
      const names = knownNamesFor(fields);
      const suggestion = suggestNames(k, names, 1)[0];
      const hint = suggestion ? ` Did you mean '${suggestion}'?` : '';
      return {
        field: here,
        expected: `field on ${stripLeadingDot(resolved.fullName)}`,
        message: `unknown field '${k}' on ${stripLeadingDot(resolved.fullName)}.${hint}`,
      };
    }
    if (depth >= maxDepth) return null;
    for (const f of fields) {
      const value = obj[f.name] !== undefined
        ? obj[f.name]
        : (f.jsonName ? obj[f.jsonName] : undefined);
      if (value === undefined || value === null) continue;
      const here = path ? `${path}.${f.name}` : f.name;
      const err = checkField(f, value, here, depth);
      if (err) return err;
    }
    return null;
  }

  function checkField(field: PbField, value: unknown, here: string, depth: number): ValidationError | null {
    if (field.map) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return {
          field: here,
          expected: `map<${field.keyType || 'string'},${field.type}>`,
          message: `expected map object at ${here}, got ${Array.isArray(value) ? 'array' : typeof value}`,
        };
      }
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const err = checkValue(field, v, `${here}.${k}`, depth);
        if (err) return err;
      }
      return null;
    }
    if (field.repeated || field.rule === 'repeated') {
      if (!Array.isArray(value)) {
        return {
          field: here,
          expected: `repeated ${field.type}`,
          message: `expected array at ${here}, got ${typeof value}`,
        };
      }
      for (let i = 0; i < value.length; i++) {
        const err = checkValue(field, value[i], `${here}[${i}]`, depth);
        if (err) return err;
      }
      return null;
    }
    return checkValue(field, value, here, depth);
  }

  function checkValue(field: PbField, value: unknown, here: string, depth: number): ValidationError | null {
    const rt = field.resolvedType;
    if (isEnum(rt)) {
      const en = rt as PbEnum;
      const fq = stripLeadingDot(en.fullName);
      const allowedNames = Object.keys(en.values);
      if (typeof value === 'number') {
        const allowedNumbers = Object.values(en.values);
        if (!allowedNumbers.includes(value)) {
          return {
            field: here,
            expected: `enum:${fq}`,
            message: `invalid enum value ${value} at ${here}; allowed: ${allowedNames.join(', ')}`,
          };
        }
        return null;
      }
      if (typeof value === 'string') {
        if (Object.prototype.hasOwnProperty.call(en.values, value)) return null;
        const suggestion = suggestNames(value, allowedNames, 1)[0];
        const hint = suggestion ? ` Did you mean '${suggestion}'?` : '';
        return {
          field: here,
          expected: `enum:${fq}`,
          message: `invalid enum value '${value}' at ${here}.${hint} Allowed: ${allowedNames.join(', ')}`,
        };
      }
      return {
        field: here,
        expected: `enum:${fq}`,
        message: `expected enum string or number at ${here}, got ${typeof value}`,
      };
    }
    if (isType(rt)) {
      return walkMessage(stripLeadingDot((rt as PbType).fullName), value, here, depth + 1);
    }
    if (!scalarOk(field.type, value)) {
      const got = typeof value === 'string'
        ? `string ('${String(value).slice(0, 24)}')`
        : Array.isArray(value)
          ? 'array'
          : typeof value;
      return {
        field: here,
        expected: field.type,
        message: `expected ${field.type} at ${here}, got ${got}`,
      };
    }
    return null;
  }

  return walkMessage(stripLeadingDot(typeName), payload, '', 0);
}
