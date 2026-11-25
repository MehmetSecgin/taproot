import { isProtoEnum, isProtoMessage, stripLeadingDot, tryCall } from './proto-node-shapes.js';
import type { PbField, PbType } from './proto-node-shapes.js';
import { firstNonEmpty, isNonEmpty } from './text-presence.js';

export type GrpcFieldShape = {
  name: string;
  type: string;
  repeated?: boolean;
  optional?: boolean;
  oneof?: string;
};

export type GrpcMessageShape = {
  name: string;
  fields: GrpcFieldShape[];
};

export type GrpcEnumShape = {
  name: string;
  values: Record<string, number>;
};

const DEFAULT_MAP_KEY_TYPE = 'string';

function describeValueType(field: PbField): string {
  const resolved = field.resolvedType;
  if (isProtoEnum(resolved)) {
    return `enum:${stripLeadingDot(resolved.fullName)}`;
  }
  return isProtoMessage(resolved) ? `message:${stripLeadingDot(resolved.fullName)}` : field.type;
}

function formatFieldType(field: PbField): string {
  const valueType = describeValueType(field);
  return field.map === true ? `map<${firstNonEmpty(field.keyType) ?? DEFAULT_MAP_KEY_TYPE},${valueType}>` : valueType;
}

function describeField(field: PbField): GrpcFieldShape {
  const isRepeated = field.repeated === true || field.rule === 'repeated' || field.map === true;
  const isOptional = field.optional === true || field.rule === 'optional';
  return {
    name: field.name,
    type: formatFieldType(field),
    ...(isRepeated ? { repeated: true } : {}),
    ...(isOptional ? { optional: true } : {}),
    ...(isNonEmpty(field.partOf?.name) ? { oneof: field.partOf.name } : {}),
  };
}

export function describeProtoMessage(type: PbType): GrpcMessageShape {
  tryCall(() => type.resolve?.());
  return {
    name: stripLeadingDot(type.fullName),
    fields: type.fieldsArray.map((field) => describeField(field)),
  };
}
