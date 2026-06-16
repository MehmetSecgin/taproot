import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { printJson, renderTable } from '../core/output.js';
import { loadProtobufRoot } from '../core/proto-loader.js';
import {
  buildRequestSkeleton,
  describeProto,
  listServices,
  resolveName,
  searchMethods,
  type ProtoDescriptor,
} from '../core/grpc-introspect.js';

function resolveProtoRoot(ctx: AppContext, opts: { datasource?: string; protoRoot?: string }): { root: string; source: string; datasource?: string } {
  if (opts.protoRoot) return { root: String(opts.protoRoot), source: 'flag', datasource: opts.datasource };
  if (!opts.datasource) {
    throw new Error('--proto-root or --datasource required for grpc describe.');
  }
  const ds = ctx.datasourceStore.get(opts.datasource);
  if (!ds) throw new Error(`Datasource not found: ${opts.datasource}`);
  if (ds.kind !== 'grpc') {
    throw new Error(`Datasource '${opts.datasource}' is kind=${ds.kind}; grpc describe needs a grpc datasource.`);
  }
  const root = String((ds.resolverHints || {})['protoRoot'] || '');
  if (!root) throw new Error(`Datasource '${opts.datasource}' has no resolverHints.protoRoot. Add via 'taproot datasource add ... --hint protoRoot=<dir>'.`);
  return { root, source: `datasource:${opts.datasource}`, datasource: opts.datasource };
}

function resolveOrThrow(query: string, names: string[], label: string): string {
  const res = resolveName(query, names);
  if (res.match) return res.match;
  if (!res.candidates.length) {
    throw new Error(`No ${label} found.`);
  }
  const list = res.candidates.slice(0, 10).join(', ');
  const more = res.candidates.length > 10 ? `, … (${res.candidates.length - 10} more)` : '';
  throw new Error(`${label} '${query}' is ambiguous or unknown. Candidates: ${list}${more}.`);
}

function callHint(datasource: string | undefined, service: string, method: string, skeleton: unknown): string {
  const ds = datasource || '<datasource>';
  const body = JSON.stringify(skeleton ?? {});
  return [
    'call:',
    `  taproot --json query --datasource ${ds} \\`,
    `    --query "${service}/${method}" \\`,
    `    --request-json '${body}'`,
  ].join('\n');
}

function renderHumanDescribe(descriptor: ProtoDescriptor, opts: { service?: string; method?: string }): string {
  const lines: string[] = [];
  if (!descriptor.services.length) {
    lines.push(opts.service ? `No service named '${opts.service}' found.` : 'No services found in proto root.');
    return lines.join('\n');
  }
  for (const svc of descriptor.services) {
    lines.push(`service ${svc.name}`);
    for (const m of svc.methods) {
      if (opts.method && m.name !== opts.method) continue;
      const reqStream = m.requestStream ? 'stream ' : '';
      const respStream = m.responseStream ? 'stream ' : '';
      lines.push(`  rpc ${m.name}(${reqStream}${m.requestType}) returns (${respStream}${m.responseType})`);
    }
  }
  if (Object.keys(descriptor.messages).length) {
    lines.push('');
    lines.push('messages:');
    for (const name of Object.keys(descriptor.messages).sort()) {
      const msg = descriptor.messages[name];
      lines.push(`  ${name}`);
      for (const f of msg.fields) {
        const flags: string[] = [];
        if (f.repeated) flags.push('repeated');
        if (f.optional) flags.push('optional');
        if (f.oneof) flags.push(`oneof:${f.oneof}`);
        const tag = flags.length ? ` [${flags.join(', ')}]` : '';
        lines.push(`    ${f.name}: ${f.type}${tag}`);
      }
    }
  }
  if (Object.keys(descriptor.enums).length) {
    lines.push('');
    lines.push('enums:');
    for (const name of Object.keys(descriptor.enums).sort()) {
      const en = descriptor.enums[name];
      const values = Object.entries(en.values).map(([k, v]) => `${k}=${v}`).join(', ');
      lines.push(`  ${name}: ${values}`);
    }
  }
  return lines.join('\n');
}

export function registerGrpc(program: Command, getCtx: () => AppContext): void {
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
    .action(async (opts) => {
      const ctx = getCtx();
      const { root, source, datasource } = resolveProtoRoot(ctx, opts);
      const maxDepth = Math.max(0, parseInt(String(opts.maxDepth || '4'), 10) || 4);
      const { protobufRoot } = await loadProtobufRoot(root);

      const allServices = listServices(protobufRoot);
      const serviceName = opts.service
        ? resolveOrThrow(String(opts.service), allServices.map((s) => s.name), 'service')
        : undefined;
      let methodName: string | undefined;
      if (opts.method) {
        const pool = serviceName ? allServices.filter((s) => s.name === serviceName) : allServices;
        methodName = resolveOrThrow(String(opts.method), pool.flatMap((s) => s.methods.map((m) => m.name)), 'method');
      }

      const descriptor = describeProto(protobufRoot, {
        service: serviceName,
        method: methodName,
        expand: { maxDepth },
      });

      const skeletons: Array<{ service: string; method: string; request: string; skeleton: unknown }> = [];
      if (opts.skeleton) {
        for (const svc of descriptor.services) {
          for (const m of svc.methods) {
            if (methodName && m.name !== methodName) continue;
            skeletons.push({
              service: svc.name,
              method: m.name,
              request: m.requestType,
              skeleton: buildRequestSkeleton(protobufRoot, m.requestType, { maxDepth }),
            });
          }
        }
      }

      if (ctx.jsonMode) {
        printJson({
          ok: true,
          data: opts.skeleton ? { ...descriptor, requestSkeletons: skeletons } : descriptor,
          meta: { protoRoot: root, protoRootSource: source, resolvedService: serviceName, resolvedMethod: methodName },
        });
        return;
      }
      const summary = renderTable([
        {
          services: descriptor.services.length,
          methods: descriptor.services.reduce((acc, s) => acc + s.methods.length, 0),
          messages: Object.keys(descriptor.messages).length,
          enums: Object.keys(descriptor.enums).length,
          protoRoot: root,
        },
      ]);
      console.log(summary);
      console.log(renderHumanDescribe(descriptor, { service: serviceName, method: methodName }));
      for (const s of skeletons) {
        console.log('');
        console.log(`request skeleton (${s.request}):`);
        console.log(JSON.stringify(s.skeleton, null, 2));
        console.log('');
        console.log(callHint(datasource, s.service, s.method, s.skeleton));
      }
    });

  grpc
    .command('list')
    .description('Services + methods only (no message expansion). --service accepts a partial name; optional [pattern] filters methods by substring.')
    .argument('[pattern]', 'substring matched against service/method/request/response names')
    .option('--datasource <name>')
    .option('--proto-root <dir>')
    .option('--service <name>', 'restrict to one service (fully-qualified, short name, or unambiguous substring)')
    .action(async (pattern, opts) => {
      const ctx = getCtx();
      const { root, source } = resolveProtoRoot(ctx, opts);
      const { protobufRoot } = await loadProtobufRoot(root);
      const services = listServices(protobufRoot);
      const serviceName = opts.service
        ? resolveOrThrow(String(opts.service), services.map((s) => s.name), 'service')
        : undefined;
      let flat = services
        .filter((s) => !serviceName || s.name === serviceName)
        .flatMap((s) =>
          s.methods.map((m) => ({
            service: s.name,
            method: m.name,
            request: m.requestType,
            response: m.responseType,
            streams: [m.requestStream ? 'req' : '', m.responseStream ? 'resp' : ''].filter(Boolean).join('+') || '',
          })),
        );
      if (pattern) {
        const p = String(pattern).toLowerCase();
        flat = flat.filter((r) => `${r.service} ${r.method} ${r.request} ${r.response}`.toLowerCase().includes(p));
      }
      if (ctx.jsonMode) {
        printJson({ ok: true, data: { methods: flat }, meta: { protoRoot: root, protoRootSource: source, resolvedService: serviceName } });
        return;
      }
      console.log(renderTable(flat));
    });

  grpc
    .command('find')
    .description('Search every service/method in the proto root by substring (matches service, method, request, and response names). Discovery shortcut when you do not know the exact name.')
    .argument('<pattern>', 'substring to search for, case-insensitive')
    .option('--datasource <name>')
    .option('--proto-root <dir>')
    .action(async (pattern, opts) => {
      const ctx = getCtx();
      const { root, source } = resolveProtoRoot(ctx, opts);
      const { protobufRoot } = await loadProtobufRoot(root);
      const matches = searchMethods(protobufRoot, String(pattern));
      if (ctx.jsonMode) {
        printJson({ ok: true, data: { matches }, meta: { protoRoot: root, protoRootSource: source, pattern: String(pattern) } });
        return;
      }
      if (!matches.length) {
        console.log(`No service/method matches '${pattern}'.`);
        return;
      }
      console.log(renderTable(matches));
    });
}
