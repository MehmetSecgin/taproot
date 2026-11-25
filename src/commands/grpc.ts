import type { Command } from 'commander';
import type { LocalExecutor } from '../cli/types.js';
import type { AppContext } from '../core/app.js';
import { badInput } from '../core/taproot-error.js';
import {
  buildRequestSkeleton,
  describeProto,
  listServices,
  searchMethods,
} from '../core/grpc-introspect.js';
import { resolveName } from '../core/name-match.js';
import type { GrpcMethodShape, GrpcServiceShape, ProtoDescriptor } from '../core/grpc-introspect.js';
import { printJson, printSuccess } from '../core/output.js';
import { loadProtobufRoot, resolveProtoRoot } from '../core/proto-loader.js';
import type { ProtobufRoot } from '../core/proto-loader.js';
import { requireDatasource } from './datasource-lookup.js';
import { emptyToUndefined } from '../core/text-presence.js';

type ProtoRootOptions = { datasource?: string; protoRoot?: string };
type GrpcDescribeOptions = ProtoRootOptions & { service?: string; method?: string; skeleton: boolean; maxDepth: string };
type GrpcListOptions = ProtoRootOptions & { service?: string };
type ProtoRootChoice = { root: string; source: string };
type RequestSkeleton = { service: string; method: string; request: string; skeleton: unknown; call: string };

const MAX_LISTED_CANDIDATES = 10;

const NO_RESOLVER_HINTS = undefined;

function protoRootFromDatasource(ctx: AppContext, datasourceName: string): ProtoRootChoice {
  const datasource = requireDatasource(ctx, datasourceName);
  if (datasource.kind !== 'grpc') {
    throw new Error(`Datasource '${datasourceName}' is kind=${datasource.kind}; grpc describe needs a grpc datasource.`);
  }
  const root = emptyToUndefined(resolveProtoRoot(undefined, datasource.resolverHints));
  if (root === undefined) {
    throw new Error(`Datasource '${datasourceName}' has no resolverHints.protoRoot. Add via 'taproot datasource add ... --hint protoRoot=<dir>'.`);
  }
  return { root, source: `datasource:${datasourceName}` };
}

function resolveProtoRootChoice(ctx: AppContext, opts: ProtoRootOptions): ProtoRootChoice {
  const flagRoot = emptyToUndefined(resolveProtoRoot(opts.protoRoot, NO_RESOLVER_HINTS));
  if (flagRoot !== undefined) {
    return { root: flagRoot, source: 'flag' };
  }
  const datasourceName = emptyToUndefined(opts.datasource);
  if (datasourceName === undefined) {
    throw badInput('--proto-root or --datasource required for grpc describe.');
  }
  return protoRootFromDatasource(ctx, datasourceName);
}

function resolveNameOrThrow(query: string, names: string[], label: string): string {
  const resolution = resolveName(query, names);
  if (resolution.match !== undefined) {
    return resolution.match;
  }
  if (resolution.candidates.length === 0) {
    throw new Error(`No ${label} found.`);
  }
  const listed = resolution.candidates.slice(0, MAX_LISTED_CANDIDATES).join(', ');
  const hiddenCount = resolution.candidates.length - MAX_LISTED_CANDIDATES;
  const more = hiddenCount > 0 ? `, … (${hiddenCount} more)` : '';
  throw new Error(`${label} '${query}' is ambiguous or unknown. Candidates: ${listed}${more}.`);
}

function resolveServiceOption(services: GrpcServiceShape[], requestedService: string | undefined): string | undefined {
  const query = emptyToUndefined(requestedService);
  return query === undefined ? undefined : resolveNameOrThrow(query, services.map((service) => service.name), 'service');
}

function resolveMethodOption(services: GrpcServiceShape[], serviceName: string | undefined, requestedMethod: string | undefined): string | undefined {
  const query = emptyToUndefined(requestedMethod);
  if (query === undefined) {
    return undefined;
  }
  const candidateServices = serviceName === undefined ? services : services.filter((service) => service.name === serviceName);
  return resolveNameOrThrow(query, candidateServices.flatMap((service) => service.methods.map((method) => method.name)), 'method');
}

function requestSkeleton(
  protobufRoot: ProtobufRoot,
  rpc: { service: GrpcServiceShape; method: GrpcMethodShape },
  selection: { maxDepth: number; datasourceName: string },
): RequestSkeleton {
  const { service, method } = rpc;
  const message = buildRequestSkeleton(protobufRoot, method.requestType, { maxDepth: selection.maxDepth });
  const skeleton = method.requestStream === true ? [message] : message;
  const body = JSON.stringify(skeleton).replaceAll('\'', `'\\''`);
  return {
    service: service.name,
    method: method.name,
    request: method.requestType,
    skeleton,
    call: `taproot query --datasource ${selection.datasourceName} --query "${service.name}/${method.name}" --request-json '${body}'`,
  };
}

function requestSkeletonsFor(
  protobufRoot: ProtobufRoot,
  descriptor: ProtoDescriptor,
  selection: { methodName?: string; maxDepth: number; datasourceName: string },
): RequestSkeleton[] {
  return descriptor.services.flatMap((service) =>
    service.methods
      .filter((method) => selection.methodName === undefined || method.name === selection.methodName)
      .map((method) => requestSkeleton(protobufRoot, { service, method }, selection)),
  );
}

function parseMaxDepth(rawMaxDepth: string): number {
  const maxDepth = Number(rawMaxDepth);
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw badInput(`--max-depth must be a non-negative integer, got '${rawMaxDepth}'.`);
  }
  return maxDepth;
}

async function describeGrpc(ctx: AppContext, opts: GrpcDescribeOptions): Promise<void> {
  const { root, source } = resolveProtoRootChoice(ctx, opts);
  const maxDepth = parseMaxDepth(opts.maxDepth);
  const { protobufRoot } = await loadProtobufRoot(root);
  const allServices = listServices(protobufRoot);
  const serviceName = resolveServiceOption(allServices, opts.service);
  const methodName = resolveMethodOption(allServices, serviceName, opts.method);
  const descriptor = describeProto(protobufRoot, { service: serviceName, method: methodName, expand: { maxDepth } });
  const datasourceName = emptyToUndefined(opts.datasource) ?? '<datasource>';
  const data = opts.skeleton
    ? { ...descriptor, requestSkeletons: requestSkeletonsFor(protobufRoot, descriptor, { methodName, maxDepth, datasourceName }) }
    : descriptor;
  printJson({
    ok: true,
    data,
    meta: { protoRoot: root, protoRootSource: source, resolvedService: serviceName, resolvedMethod: methodName },
  });
}

function methodRows(services: GrpcServiceShape[], serviceName: string | undefined): Record<string, string>[] {
  return services
    .filter((service) => serviceName === undefined || service.name === serviceName)
    .flatMap((service) =>
      service.methods.map((method) => ({
        service: service.name,
        method: method.name,
        request: method.requestType,
        response: method.responseType,
        streams: [method.requestStream === true ? 'req' : '', method.responseStream === true ? 'resp' : ''].filter(Boolean).join('+'),
      })),
    );
}

async function listGrpc(ctx: AppContext, pattern: string | undefined, opts: GrpcListOptions): Promise<void> {
  const { root, source } = resolveProtoRootChoice(ctx, opts);
  const { protobufRoot } = await loadProtobufRoot(root);
  const services = listServices(protobufRoot);
  const serviceName = resolveServiceOption(services, opts.service);
  const rows = methodRows(services, serviceName);
  const needle = emptyToUndefined(pattern)?.toLowerCase();
  const methods = needle === undefined
    ? rows
    : rows.filter((row) => `${row.service} ${row.method} ${row.request} ${row.response}`.toLowerCase().includes(needle));
  printSuccess({ methods }, { protoRoot: root, protoRootSource: source, resolvedService: serviceName });
}

async function findGrpc(ctx: AppContext, pattern: string, opts: ProtoRootOptions): Promise<void> {
  const { root, source } = resolveProtoRootChoice(ctx, opts);
  const { protobufRoot } = await loadProtobufRoot(root);
  const matches = searchMethods(protobufRoot, pattern);
  printSuccess({ matches }, { protoRoot: root, protoRootSource: source, pattern });
}

export function grpcCommand(program: Command, executor: LocalExecutor): void {
  const grpc = program.command('grpc').description('gRPC datasource introspection');

  grpc
    .command('describe')
    .description('List services + methods from a grpc datasource proto root. --service/--method accept partial names (short name or substring). Drill into a method to see request/response shape; add --skeleton for a ready-to-edit request body + call line.')
    .option('--datasource <name>', 'grpc datasource whose resolverHints.protoRoot will be loaded')
    .option('--proto-root <dir>', 'override proto root (otherwise read from --datasource resolverHints.protoRoot)')
    .option('--service <name>', 'restrict output to one service. Accepts the fully-qualified name, the short name (CatalogService), or any unambiguous substring.')
    .option('--method <name>', 'restrict expanded messages to a single rpc method (exact or unambiguous substring)')
    .option('--skeleton', 'emit an example request JSON for the matched method(s) and a ready-to-run query call line', false)
    .option('--max-depth <n>', 'message expansion depth cap (default 4)', '4')
    .action(async (opts: GrpcDescribeOptions) => {
      await describeGrpc(executor.context(), opts);
    });

  grpc
    .command('list')
    .description('Services + methods only (no message expansion). --service accepts a partial name; optional [pattern] filters methods by substring.')
    .argument('[pattern]', 'substring matched against service/method/request/response names')
    .option('--datasource <name>', 'grpc datasource whose protoRoot hint to read')
    .option('--proto-root <dir>', 'proto source directory, when no datasource is registered')
    .option('--service <name>', 'restrict to one service (fully-qualified, short name, or unambiguous substring)')
    .action(async (pattern: string | undefined, opts: GrpcListOptions) => {
      await listGrpc(executor.context(), pattern, opts);
    });

  grpc
    .command('find')
    .description('Search every service/method in the proto root by substring (matches service, method, request, and response names). Discovery shortcut when you do not know the exact name.')
    .argument('<pattern>', 'substring to search for, case-insensitive')
    .option('--datasource <name>', 'grpc datasource whose protoRoot hint to read')
    .option('--proto-root <dir>', 'proto source directory, when no datasource is registered')
    .action(async (pattern: string, opts: ProtoRootOptions) => {
      await findGrpc(executor.context(), pattern, opts);
    });
}
