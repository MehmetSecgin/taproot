import { matchName, resolveName } from '../../core/name-match.js';
import type { GrpcMethodShape, GrpcServiceShape } from '../../core/grpc-introspect.js';
import { textUnlessFalsy } from '../../core/text-presence.js';

export type ServiceMethodRef = { service: string; method: string };

const MAX_NAME_SUGGESTIONS = 5;

export function parseServiceMethodRef(input: string): ServiceMethodRef {
  const text = textUnlessFalsy(input).trim();
  if (text === '') {
    throw new Error('empty grpc query; expected "<package.Service/Method>"');
  }
  const slash = text.indexOf('/');
  if (slash <= 0 || slash === text.length - 1) {
    throw new Error(`grpc query '${text}' missing '/' separator. Expected "<package.Service/Method>" e.g. "com.example.catalog.v1.CatalogService/getItems"`);
  }
  return { service: text.slice(0, slash), method: text.slice(slash + 1) };
}

function nameHint(wanted: string, names: string[]): string {
  const near = resolveName(wanted, names);
  if (near.match !== undefined && near.match !== '') {
    return ` Did you mean '${near.match}'?`;
  }
  return near.candidates.length > 0 ? ` Closest: ${near.candidates.slice(0, MAX_NAME_SUGGESTIONS).join(', ')}.` : '';
}

function findByMatchedName<Item extends { name: string }>(items: Item[], wanted: string): Item | undefined {
  const matched = matchName(wanted, items.map((item) => item.name));
  return matched === undefined ? undefined : items.find((item) => item.name === matched);
}

export function resolveMethod(services: GrpcServiceShape[], ref: ServiceMethodRef): { service: string; method: GrpcMethodShape } {
  const service = findByMatchedName(services, ref.service);
  if (service === undefined) {
    throw new Error(`grpc service '${ref.service}' not found in proto root.${nameHint(ref.service, services.map((item) => item.name))} Run 'taproot grpc list' to see services.`);
  }
  const method = findByMatchedName(service.methods, ref.method);
  if (method === undefined) {
    const methodNames = service.methods.map((item) => item.name);
    throw new Error(`grpc method '${ref.method}' not found on ${service.name}.${nameHint(ref.method, methodNames)} Available: ${methodNames.join(', ')}.`);
  }
  return { service: service.name, method };
}
