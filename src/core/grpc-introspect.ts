import { loadProtobufRoot, type ProtobufRoot } from './proto-loader.js';
import type {
  RpcEnumShape,
  RpcFieldShape,
  RpcMessageShape,
  RpcMethodShape,
  RpcServiceShape,
} from '../types/core.js';

interface PbField {
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
}

interface PbType {
  fullName: string;
  name: string;
  fieldsArray: PbField[];
  resolve?: () => void;
}

interface PbEnum {
  fullName: string;
  name: string;
  values: Record<string, number>;
}

interface PbMethod {
  name: string;
  requestType: string;
  responseType: string;
  requestStream?: boolean;
  responseStream?: boolean;
  resolvedRequestType?: PbType;
  resolvedResponseType?: PbType;
  resolve?: () => void;
}

interface PbService {
  fullName: string;
  name: string;
  methodsArray: PbMethod[];
  resolveAll?: () => void;
}

interface PbNs {
  fullName?: string;
  name?: string;
  nestedArray?: PbNs[];
  methodsArray?: unknown;
  fieldsArray?: unknown;
  values?: unknown;
}

export interface ProtoDescriptor {
  services: RpcServiceShape[];
  messages: Record<string, RpcMessageShape>;
  enums: Record<string, RpcEnumShape>;
}

export interface ExpandOptions {
  maxDepth?: number;
  maxMessages?: number;
}

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_MESSAGES = 256;

function isType(node: unknown): node is PbType {
  return !!node && typeof node === 'object' && Array.isArray((node as PbType).fieldsArray);
}

function isEnum(node: unknown): node is PbEnum {
  if (!node || typeof node !== 'object') return false;
  const obj = node as Record<string, unknown>;
  return !!obj.values && !Array.isArray(obj.fieldsArray) && !Array.isArray(obj.methodsArray);
}

function isService(node: unknown): node is PbService {
  return !!node && typeof node === 'object' && Array.isArray((node as PbService).methodsArray);
}

function stripLeadingDot(name: string): string {
  return name.startsWith('.') ? name.slice(1) : name;
}

function walkServices(root: ProtobufRoot): PbService[] {
  const out: PbService[] = [];
  const visit = (nodes: PbNs[] | undefined): void => {
    if (!nodes) return;
    for (const n of nodes) {
      if (isService(n)) out.push(n);
      visit((n as PbNs).nestedArray);
    }
  };
  visit(root.nestedArray as PbNs[] | undefined);
  return out;
}

function formatFieldType(field: PbField): string {
  const rt = field.resolvedType;
  if (field.map) {
    const valType = isEnum(rt)
      ? `enum:${stripLeadingDot((rt as PbEnum).fullName)}`
      : isType(rt)
        ? `message:${stripLeadingDot((rt as PbType).fullName)}`
        : field.type;
    return `map<${field.keyType || 'string'},${valType}>`;
  }
  if (isEnum(rt)) return `enum:${stripLeadingDot((rt as PbEnum).fullName)}`;
  if (isType(rt)) return `message:${stripLeadingDot((rt as PbType).fullName)}`;
  return field.type;
}

function describeMessage(type: PbType): RpcMessageShape {
  if (typeof type.resolve === 'function') {
    try { type.resolve(); } catch { /* ignore */ }
  }
  const fields: RpcFieldShape[] = type.fieldsArray.map((field) => {
    const shape: RpcFieldShape = {
      name: field.name,
      type: formatFieldType(field),
    };
    if (field.repeated || field.rule === 'repeated' || field.map) shape.repeated = true;
    if (field.optional || field.rule === 'optional') shape.optional = true;
    if (field.partOf?.name) shape.oneof = field.partOf.name;
    return shape;
  });
  return {
    name: stripLeadingDot(type.fullName),
    fields,
  };
}

export function expandMessage(
  root: ProtobufRoot,
  messageName: string,
  opts: ExpandOptions = {},
): { messages: Record<string, RpcMessageShape>; enums: Record<string, RpcEnumShape> } {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxMessages = opts.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const messages: Record<string, RpcMessageShape> = {};
  const enums: Record<string, RpcEnumShape> = {};
  const queue: Array<{ name: string; depth: number }> = [{ name: stripLeadingDot(messageName), depth: 0 }];
  while (queue.length) {
    const { name, depth } = queue.shift()!;
    if (messages[name]) continue;
    if (Object.keys(messages).length >= maxMessages) break;
    let resolved: unknown = null;
    try { resolved = root.lookup(name); } catch { resolved = null; }
    if (!resolved) continue;
    if (isType(resolved)) {
      messages[name] = describeMessage(resolved);
      if (depth >= maxDepth) continue;
      for (const field of resolved.fieldsArray) {
        const rt = field.resolvedType;
        if (!rt) continue;
        if (isEnum(rt)) {
          const fq = stripLeadingDot((rt as PbEnum).fullName);
          if (fq && !enums[fq]) enums[fq] = { name: fq, values: { ...(rt as PbEnum).values } };
        } else if (isType(rt)) {
          const fq = stripLeadingDot((rt as PbType).fullName);
          if (fq) queue.push({ name: fq, depth: depth + 1 });
        }
      }
    } else if (isEnum(resolved)) {
      enums[name] = { name, values: { ...(resolved as PbEnum).values } };
    }
  }
  return { messages, enums };
}

function describeMethod(method: PbMethod): RpcMethodShape {
  if (typeof method.resolve === 'function') {
    try { method.resolve(); } catch { /* ignore */ }
  }
  const req = method.resolvedRequestType?.fullName || method.requestType;
  const resp = method.resolvedResponseType?.fullName || method.responseType;
  const out: RpcMethodShape = {
    name: method.name,
    requestType: stripLeadingDot(req),
    responseType: stripLeadingDot(resp),
  };
  if (method.requestStream) out.requestStream = true;
  if (method.responseStream) out.responseStream = true;
  return out;
}

export function listServices(root: ProtobufRoot): RpcServiceShape[] {
  return walkServices(root).map((svc) => {
    if (typeof svc.resolveAll === 'function') {
      try { svc.resolveAll(); } catch { /* ignore */ }
    }
    return {
      name: stripLeadingDot(svc.fullName),
      methods: svc.methodsArray.map(describeMethod),
    };
  });
}

export interface DescribeOptions {
  service?: string;
  method?: string;
  expand?: ExpandOptions;
}

export function describeProto(root: ProtobufRoot, opts: DescribeOptions = {}): ProtoDescriptor {
  let services = listServices(root);
  if (opts.service) services = services.filter((s) => s.name === opts.service);
  const messages: Record<string, RpcMessageShape> = {};
  const enums: Record<string, RpcEnumShape> = {};
  for (const svc of services) {
    for (const method of svc.methods) {
      if (opts.method && method.name !== opts.method) continue;
      const req = expandMessage(root, method.requestType, opts.expand);
      const resp = expandMessage(root, method.responseType, opts.expand);
      Object.assign(messages, req.messages, resp.messages);
      Object.assign(enums, req.enums, resp.enums);
    }
  }
  return { services, messages, enums };
}

export async function describeProtoRoot(protoRoot: string, opts: DescribeOptions = {}): Promise<ProtoDescriptor> {
  const { protobufRoot } = await loadProtobufRoot(protoRoot);
  return describeProto(protobufRoot, opts);
}
