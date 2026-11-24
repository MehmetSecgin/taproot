import { suggestNames } from './name-match.js';
import { isPlainRecord } from './json-shapes.js';
import type { ProtobufRoot } from './proto-loader.js';
import { isProtoEnum, isProtoMessage, stripLeadingDot, tryCall } from './proto-node-shapes.js';
import type { PbEnum, PbField, PbType } from './proto-node-shapes.js';
import { isValidScalar } from './proto-scalar-types.js';
import { firstNonEmpty, isNonEmpty } from './text-presence.js';

type RequestValidationIssue = {
  field: string;
  expected: string;
  message: string;
};

type ValuePosition = {
  path: string;
  depth: number;
};

const MAX_DEPTH = 8;
const MAX_ECHOED_STRING_LENGTH = 24;
const DEFAULT_MAP_KEY_TYPE = 'string';

function describeJsType(value: unknown): string {
  return Array.isArray(value) ? 'array' : typeof value;
}

function describeActualValue(value: unknown): string {
  return typeof value === 'string' ? `string ('${value.slice(0, MAX_ECHOED_STRING_LENGTH)}')` : describeJsType(value);
}

function didYouMeanHint(name: string, candidates: string[]): string {
  const [suggestion] = suggestNames(name, candidates, 1);
  return isNonEmpty(suggestion) ? ` Did you mean '${suggestion}'?` : '';
}

function childPath(path: string, name: string): string {
  return path === '' ? name : `${path}.${name}`;
}

function checkEnumValue(rpcEnum: PbEnum, value: unknown, path: string): RequestValidationIssue | null {
  const expected = `enum:${stripLeadingDot(rpcEnum.fullName)}`;
  const allowedNames = Object.keys(rpcEnum.values);
  if (typeof value === 'number') {
    const isAllowed = Object.values(rpcEnum.values).includes(value);
    return isAllowed ? null : { field: path, expected, message: `invalid enum value ${value} at ${path}; allowed: ${allowedNames.join(', ')}` };
  }
  if (typeof value === 'string') {
    return Object.hasOwn(rpcEnum.values, value)
      ? null
      : { field: path, expected, message: `invalid enum value '${value}' at ${path}.${didYouMeanHint(value, allowedNames)} Allowed: ${allowedNames.join(', ')}` };
  }
  return { field: path, expected, message: `expected enum string or number at ${path}, got ${typeof value}` };
}

function checkMapShape(field: PbField, value: unknown, path: string): RequestValidationIssue | null {
  if (isPlainRecord(value)) {
    return null;
  }
  return {
    field: path,
    expected: `map<${firstNonEmpty(field.keyType) ?? DEFAULT_MAP_KEY_TYPE},${field.type}>`,
    message: `expected map object at ${path}, got ${describeJsType(value)}`,
  };
}

function checkRepeatedShape(field: PbField, value: unknown, path: string): RequestValidationIssue | null {
  if (Array.isArray(value)) {
    return null;
  }
  return { field: path, expected: `repeated ${field.type}`, message: `expected array at ${path}, got ${typeof value}` };
}

function firstIssue<Item>(items: Item[], check: (item: Item, index: number) => RequestValidationIssue | null): RequestValidationIssue | null {
  for (const [index, item] of items.entries()) {
    const issue = check(item, index);
    if (issue !== null) {
      return issue;
    }
  }
  return null;
}

function findUnknownField(type: PbType, value: Record<string, unknown>, path: string): RequestValidationIssue | null {
  const fieldNames = type.fieldsArray.map((field) => field.name);
  const unknownName = Object.keys(value).find((name) => !fieldNames.includes(name));
  if (unknownName === undefined) {
    return null;
  }
  const typeName = stripLeadingDot(type.fullName);
  return {
    field: childPath(path, unknownName),
    expected: `field on ${typeName}`,
    message: `unknown field '${unknownName}' on ${typeName}.${didYouMeanHint(unknownName, fieldNames)}`,
  };
}

class RequestValidator {
  private readonly root: ProtobufRoot;

  public constructor(root: ProtobufRoot) {
    this.root = root;
  }

  public validate(typeName: string, payload: unknown): RequestValidationIssue | null {
    return this.checkMessage(stripLeadingDot(typeName), payload, { path: '', depth: 0 });
  }

  private lookup(typeName: string): unknown {
    try {
      return this.root.lookup(typeName);
    } catch {
      return null;
    }
  }

  private checkMessage(typeName: string, value: unknown, position: ValuePosition): RequestValidationIssue | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (!isPlainRecord(value)) {
      const where = position.path === '' ? typeName : position.path;
      return { field: where, expected: `message:${typeName}`, message: `expected object at ${where}, got ${describeJsType(value)}` };
    }
    const resolved = this.lookup(typeName);
    return isProtoMessage(resolved) ? this.checkMessageFields(resolved, value, position) : null;
  }

  private checkMessageFields(type: PbType, value: Record<string, unknown>, position: ValuePosition): RequestValidationIssue | null {
    tryCall(() => type.resolve?.());
    const unknownFieldIssue = findUnknownField(type, value, position.path);
    if (unknownFieldIssue !== null || position.depth >= MAX_DEPTH) {
      return unknownFieldIssue;
    }
    const presentFields = type.fieldsArray.filter((field) => value[field.name] !== undefined && value[field.name] !== null);
    return firstIssue(presentFields, (field) => this.checkField(field, value[field.name], { path: childPath(position.path, field.name), depth: position.depth }));
  }

  private checkField(field: PbField, value: unknown, position: ValuePosition): RequestValidationIssue | null {
    if (field.map === true) {
      return checkMapShape(field, value, position.path) ?? this.checkMapEntries(field, value, position);
    }
    if (field.repeated === true || field.rule === 'repeated') {
      return checkRepeatedShape(field, value, position.path) ?? this.checkListItems(field, value, position);
    }
    return this.checkValue(field, value, position);
  }

  private checkMapEntries(field: PbField, value: unknown, position: ValuePosition): RequestValidationIssue | null {
    const entries = isPlainRecord(value) ? Object.entries(value) : [];
    return firstIssue(entries, ([key, entryValue]) => this.checkValue(field, entryValue, { ...position, path: `${position.path}.${key}` }));
  }

  private checkListItems(field: PbField, value: unknown, position: ValuePosition): RequestValidationIssue | null {
    const items: unknown[] = Array.isArray(value) ? value : [];
    return firstIssue(items, (item, index) => this.checkValue(field, item, { ...position, path: `${position.path}[${index}]` }));
  }

  private checkValue(field: PbField, value: unknown, position: ValuePosition): RequestValidationIssue | null {
    const { resolvedType } = field;
    if (isProtoEnum(resolvedType)) {
      return checkEnumValue(resolvedType, value, position.path);
    }
    if (isProtoMessage(resolvedType)) {
      return this.checkMessage(stripLeadingDot(resolvedType.fullName), value, { path: position.path, depth: position.depth + 1 });
    }
    if (isValidScalar(field.type, value)) {
      return null;
    }
    return { field: position.path, expected: field.type, message: `expected ${field.type} at ${position.path}, got ${describeActualValue(value)}` };
  }
}

export function validateGrpcRequest(root: ProtobufRoot, typeName: string, payload: unknown): RequestValidationIssue | null {
  return new RequestValidator(root).validate(typeName, payload);
}
