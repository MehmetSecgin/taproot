import { isList } from './json-shapes.js';
import { propertyOf } from './object-property.js';

export type PbField = {
  name: string;
  type: string;
  rule?: string;
  repeated?: boolean;
  optional?: boolean;
  required?: boolean;
  partOf?: { name: string };
  map?: boolean;
  keyType?: string;
  resolvedType?: unknown;
  resolve?: () => void;
};

export type PbType = {
  fullName: string;
  name: string;
  fieldsArray: PbField[];
  resolve?: () => void;
};

export type PbEnum = {
  fullName: string;
  name: string;
  values: Record<string, number>;
};

export type PbMethod = {
  name: string;
  requestType: string;
  responseType: string;
  requestStream?: boolean;
  responseStream?: boolean;
  resolvedRequestType?: PbType;
  resolvedResponseType?: PbType;
  resolve?: () => void;
};

export type PbService = {
  fullName: string;
  name: string;
  methodsArray: PbMethod[];
  resolveAll?: () => void;
};

export function isProtoMessage(node: unknown): node is PbType {
  return isList(propertyOf(node, 'fieldsArray'));
}

export function isProtoEnum(node: unknown): node is PbEnum {
  return Boolean(propertyOf(node, 'values'))
    && !isList(propertyOf(node, 'fieldsArray'))
    && !isList(propertyOf(node, 'methodsArray'));
}

function isProtoService(node: unknown): node is PbService {
  return isList(propertyOf(node, 'methodsArray'));
}

export function stripLeadingDot(name: string): string {
  return name.startsWith('.') ? name.slice(1) : name;
}

export function tryCall(run: () => void): boolean {
  try {
    run();
    return true;
  } catch {
    return false;
  }
}

export function collectServices(nodes: unknown): PbService[] {
  if (!isList(nodes)) {
    return [];
  }
  return nodes.flatMap((node) => [
    ...(isProtoService(node) ? [node] : []),
    ...collectServices(propertyOf(node, 'nestedArray')),
  ]);
}
