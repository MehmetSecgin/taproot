import type { ProtobufRoot } from './proto-loader.js';
import { str } from './strings.js';
import type {
  RpcEnumShape,
  RpcFieldShape,
  RpcMessageShape,
  RpcMethodShape,
  RpcServiceShape,
} from '../types/core.js';

export interface PbField {
  name: string;
  jsonName?: string;
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

export interface PbType {
  fullName: string;
  name: string;
  fieldsArray: PbField[];
  resolve?: () => void;
}

export interface PbEnum {
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
}

const DEFAULT_MAX_DEPTH = 4;
const MAX_MESSAGES = 256;

export function isType(node: unknown): node is PbType {
  return !!node && typeof node === 'object' && Array.isArray((node as PbType).fieldsArray);
}

export function isEnum(node: unknown): node is PbEnum {
  if (!node || typeof node !== 'object') return false;
  const obj = node as Record<string, unknown>;
  return !!obj.values && !Array.isArray(obj.fieldsArray) && !Array.isArray(obj.methodsArray);
}

function isService(node: unknown): node is PbService {
  return !!node && typeof node === 'object' && Array.isArray((node as PbService).methodsArray);
}

export function stripLeadingDot(name: string): string {
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
  const messages: Record<string, RpcMessageShape> = {};
  const enums: Record<string, RpcEnumShape> = {};
  const queue: Array<{ name: string; depth: number }> = [{ name: stripLeadingDot(messageName), depth: 0 }];
  while (queue.length) {
    const { name, depth } = queue.shift()!;
    if (messages[name]) continue;
    if (Object.keys(messages).length >= MAX_MESSAGES) break;
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

function shortName(fq: string): string {
  const i = fq.lastIndexOf('.');
  return i >= 0 ? fq.slice(i + 1) : fq;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

export function suggestNames(query: string, names: string[], limit = 5): string[] {
  const q = query.toLowerCase();
  return [...new Set(names)]
    .map((n) => ({ n, d: Math.min(levenshtein(q, n.toLowerCase()), levenshtein(q, shortName(n).toLowerCase())) }))
    .sort((x, y) => x.d - y.d || x.n.localeCompare(y.n))
    .slice(0, limit)
    .map((x) => x.n);
}

export interface NameResolution {
  match?: string;
  candidates: string[];
}

export function resolveName(query: string, names: string[]): NameResolution {
  const q = str(query).trim();
  if (!q) return { candidates: names };
  if (names.includes(q)) return { match: q, candidates: [q] };
  const ql = q.toLowerCase();
  const shortExact = names.filter((n) => shortName(n).toLowerCase() === ql);
  if (shortExact.length === 1) return { match: shortExact[0], candidates: shortExact };
  if (shortExact.length > 1) return { candidates: shortExact };
  const sub = names.filter((n) => n.toLowerCase().includes(ql) || shortName(n).toLowerCase().includes(ql));
  if (sub.length === 1) return { match: sub[0], candidates: sub };
  if (sub.length > 1) return { candidates: sub };
  return { candidates: suggestNames(q, names) };
}

export interface MethodMatch {
  service: string;
  method: string;
  requestType: string;
  responseType: string;
  streams: string;
}

function methodStreams(m: RpcMethodShape): string {
  return [m.requestStream ? 'req' : '', m.responseStream ? 'resp' : ''].filter(Boolean).join('+');
}

export function searchMethods(root: ProtobufRoot, pattern: string): MethodMatch[] {
  const p = str(pattern).toLowerCase();
  const out: MethodMatch[] = [];
  for (const svc of listServices(root)) {
    for (const m of svc.methods) {
      const hay = `${svc.name} ${m.name} ${m.requestType} ${m.responseType}`.toLowerCase();
      if (!p || hay.includes(p)) {
        out.push({
          service: svc.name,
          method: m.name,
          requestType: m.requestType,
          responseType: m.responseType,
          streams: methodStreams(m),
        });
      }
    }
  }
  return out;
}

function scalarPlaceholder(type: string): unknown {
  if (type === 'bool') return false;
  if (type === 'string') return '<string>';
  if (type === 'bytes') return '<bytes:base64>';
  if (type === 'float' || type === 'double') return 0;
  if (/(^|u|s)int|fixed/.test(type)) return 0;
  return `<${type}>`;
}

export function buildRequestSkeleton(
  root: ProtobufRoot,
  messageName: string,
  opts: ExpandOptions = {},
): unknown {
  const { messages, enums } = expandMessage(root, messageName, { maxDepth: opts.maxDepth ?? 6 });
  const seen = new Set<string>();

  const valueForType = (type: string): unknown => {
    if (type.startsWith('message:')) return build(type.slice('message:'.length));
    if (type.startsWith('enum:')) {
      const en = enums[type.slice('enum:'.length)];
      const first = en ? Object.keys(en.values)[0] : undefined;
      return first ?? '<enum>';
    }
    return scalarPlaceholder(type);
  };

  const valueForField = (f: RpcFieldShape): unknown => {
    if (f.type.startsWith('map<')) {
      const inner = f.type.slice(4, -1);
      const valType = inner.slice(inner.indexOf(',') + 1);
      return { '<key>': valueForType(valType) };
    }
    const v = valueForType(f.type);
    return f.repeated ? [v] : v;
  };

  function build(name: string): Record<string, unknown> {
    const msg = messages[stripLeadingDot(name)];
    if (!msg || seen.has(name)) return {};
    seen.add(name);
    const out: Record<string, unknown> = {};
    for (const f of msg.fields) out[f.name] = valueForField(f);
    seen.delete(name);
    return out;
  }

  return build(stripLeadingDot(messageName));
}
