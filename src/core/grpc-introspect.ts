import { collectServices, stripLeadingDot, tryCall } from './proto-node-shapes.js';
import type { PbMethod } from './proto-node-shapes.js';
import { expandQueuedMessage } from './proto-message-expansion.js';
import type { Expansion, QueuedMessage } from './proto-message-expansion.js';
import { scalarPlaceholder } from './proto-scalar-types.js';
import type { GrpcEnumShape, GrpcFieldShape, GrpcMessageShape } from './proto-shape-description.js';
import type { ProtobufRoot } from './proto-loader.js';
import { firstNonEmpty, isNonEmpty, textUnlessFalsy } from './text-presence.js';

export type GrpcMethodShape = {
  name: string;
  requestType: string;
  responseType: string;
  requestStream?: boolean;
  responseStream?: boolean;
};

export type GrpcServiceShape = {
  name: string;
  methods: GrpcMethodShape[];
};

export type ProtoDescriptor = {
  services: GrpcServiceShape[];
  messages: Record<string, GrpcMessageShape>;
  enums: Record<string, GrpcEnumShape>;
};

type ExpandOptions = {
  maxDepth?: number;
};

type DescribeOptions = {
  service?: string;
  method?: string;
  expand?: ExpandOptions;
};

type MethodMatch = {
  service: string;
  method: string;
  requestType: string;
  responseType: string;
  streams: string;
};

const SKELETON_MAX_DEPTH = 6;
const DEFAULT_MAX_DEPTH = 4;
const MAX_MESSAGES = 256;
const MAP_TYPE_PREFIX = 'map<';

export function expandMessage(root: ProtobufRoot, messageName: string, options: ExpandOptions = {}): Expansion {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const expansion: Expansion = { messages: {}, enums: {} };
  const queue: QueuedMessage[] = [{ name: stripLeadingDot(messageName), depth: 0 }];
  for (let position = 0; position < queue.length && Object.keys(expansion.messages).length < MAX_MESSAGES; position += 1) {
    queue.push(...expandQueuedMessage({ root, maxDepth, expansion }, queue[position]));
  }
  return expansion;
}

function describeMethod(method: PbMethod): GrpcMethodShape {
  tryCall(() => method.resolve?.());
  const requestType = firstNonEmpty(method.resolvedRequestType?.fullName) ?? method.requestType;
  const responseType = firstNonEmpty(method.resolvedResponseType?.fullName) ?? method.responseType;
  return {
    name: method.name,
    requestType: stripLeadingDot(requestType),
    responseType: stripLeadingDot(responseType),
    ...(method.requestStream === true ? { requestStream: true } : {}),
    ...(method.responseStream === true ? { responseStream: true } : {}),
  };
}

export function listServices(root: ProtobufRoot): GrpcServiceShape[] {
  return collectServices(root.nestedArray).map((service) => {
    tryCall(() => service.resolveAll?.());
    return {
      name: stripLeadingDot(service.fullName),
      methods: service.methodsArray.map((method) => describeMethod(method)),
    };
  });
}

function mergeExpansions(target: Expansion, ...sources: Expansion[]): void {
  for (const source of sources) {
    Object.assign(target.messages, source.messages);
    Object.assign(target.enums, source.enums);
  }
}

export function describeProto(root: ProtobufRoot, options: DescribeOptions = {}): ProtoDescriptor {
  const allServices = listServices(root);
  const services = isNonEmpty(options.service) ? allServices.filter((service) => service.name === options.service) : allServices;
  const expansion: Expansion = { messages: {}, enums: {} };
  for (const service of services) {
    const methods = service.methods.filter((method) => !isNonEmpty(options.method) || method.name === options.method);
    for (const method of methods) {
      mergeExpansions(
        expansion,
        expandMessage(root, method.requestType, options.expand),
        expandMessage(root, method.responseType, options.expand),
      );
    }
  }
  return { services, ...expansion };
}

function methodStreams(method: GrpcMethodShape): string {
  return [method.requestStream === true ? 'req' : '', method.responseStream === true ? 'resp' : ''].filter(Boolean).join('+');
}

export function searchMethods(root: ProtobufRoot, pattern: string): MethodMatch[] {
  const lowerPattern = textUnlessFalsy(pattern).toLowerCase();
  return listServices(root).flatMap((service) =>
    service.methods
      .filter((method) => {
        const haystack = `${service.name} ${method.name} ${method.requestType} ${method.responseType}`.toLowerCase();
        return lowerPattern === '' || haystack.includes(lowerPattern);
      })
      .map((method) => ({
        service: service.name,
        method: method.name,
        requestType: method.requestType,
        responseType: method.responseType,
        streams: methodStreams(method),
      })),
  );
}

class RequestSkeletonBuilder {
  private readonly messages: Record<string, GrpcMessageShape>;
  private readonly enums: Record<string, GrpcEnumShape>;
  private readonly inProgress = new Set<string>();

  public constructor(expansion: Expansion) {
    this.messages = expansion.messages;
    this.enums = expansion.enums;
  }

  public buildMessage(name: string): Record<string, unknown> {
    const message = this.messages[stripLeadingDot(name)];
    if (message === undefined || this.inProgress.has(name)) {
      return {};
    }
    this.inProgress.add(name);
    const skeleton = Object.fromEntries(message.fields.map((field) => [field.name, this.valueForField(field)]));
    this.inProgress.delete(name);
    return skeleton;
  }

  private valueForType(type: string): unknown {
    if (type.startsWith('message:')) {
      return this.buildMessage(type.slice('message:'.length));
    }
    if (type.startsWith('enum:')) {
      const rpcEnum = this.enums[type.slice('enum:'.length)];
      return (rpcEnum === undefined ? undefined : Object.keys(rpcEnum.values)[0]) ?? '<enum>';
    }
    return scalarPlaceholder(type);
  }

  private valueForField(field: GrpcFieldShape): unknown {
    if (field.type.startsWith(MAP_TYPE_PREFIX)) {
      const mapParameters = field.type.slice(MAP_TYPE_PREFIX.length, -1);
      return { '<key>': this.valueForType(mapParameters.slice(mapParameters.indexOf(',') + 1)) };
    }
    const value = this.valueForType(field.type);
    return field.repeated === true ? [value] : value;
  }
}

export function buildRequestSkeleton(root: ProtobufRoot, messageName: string, options: ExpandOptions = {}): unknown {
  const expansion = expandMessage(root, messageName, { maxDepth: options.maxDepth ?? SKELETON_MAX_DEPTH });
  return new RequestSkeletonBuilder(expansion).buildMessage(stripLeadingDot(messageName));
}
