import type { ProtobufRoot } from './proto-loader.js';
import { isProtoEnum, isProtoMessage, stripLeadingDot } from './proto-node-shapes.js';
import type { PbType } from './proto-node-shapes.js';
import { describeProtoMessage } from './proto-shape-description.js';
import type { GrpcEnumShape, GrpcMessageShape } from './proto-shape-description.js';

export type Expansion = {
  messages: Record<string, GrpcMessageShape>;
  enums: Record<string, GrpcEnumShape>;
};

export type QueuedMessage = { name: string; depth: number };

export type ExpansionContext = {
  root: ProtobufRoot;
  maxDepth: number;
  expansion: Expansion;
};

function lookupNode(root: ProtobufRoot, name: string): unknown {
  try {
    return root.lookup(name);
  } catch {
    return null;
  }
}

function addReferencedEnum(rpcEnum: { fullName: string; values: Record<string, number> }, enums: Record<string, GrpcEnumShape>): void {
  const name = stripLeadingDot(rpcEnum.fullName);
  if (name !== '' && enums[name] === undefined) {
    enums[name] = { name, values: { ...rpcEnum.values } };
  }
}

function referencedMessages(type: PbType, depth: number, enums: Record<string, GrpcEnumShape>): QueuedMessage[] {
  const queued: QueuedMessage[] = [];
  for (const field of type.fieldsArray) {
    const referenced = field.resolvedType;
    if (isProtoEnum(referenced)) {
      addReferencedEnum(referenced, enums);
    } else if (isProtoMessage(referenced) && stripLeadingDot(referenced.fullName) !== '') {
      queued.push({ name: stripLeadingDot(referenced.fullName), depth: depth + 1 });
    }
  }
  return queued;
}

function expandMessageNode(context: ExpansionContext, entry: QueuedMessage, type: PbType): QueuedMessage[] {
  context.expansion.messages[entry.name] = describeProtoMessage(type);
  return entry.depth >= context.maxDepth ? [] : referencedMessages(type, entry.depth, context.expansion.enums);
}

export function expandQueuedMessage(context: ExpansionContext, entry: QueuedMessage): QueuedMessage[] {
  const { expansion } = context;
  const { name } = entry;
  if (expansion.messages[name] !== undefined) {
    return [];
  }
  const resolved = lookupNode(context.root, name);
  if (isProtoMessage(resolved)) {
    return expandMessageNode(context, entry, resolved);
  }
  if (isProtoEnum(resolved)) {
    expansion.enums[name] = { name, values: { ...resolved.values } };
  }
  return [];
}
