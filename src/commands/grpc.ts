import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { printJson, renderTable } from '../core/output.js';
import { describeProtoRoot, type ProtoDescriptor } from '../core/grpc-introspect.js';

function resolveProtoRoot(ctx: AppContext, opts: { datasource?: string; protoRoot?: string }): { root: string; source: string } {
  if (opts.protoRoot) return { root: String(opts.protoRoot), source: 'flag' };
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
  return { root, source: `datasource:${opts.datasource}` };
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
    .description('List services + methods from a grpc datasource proto root. Optionally drill into a method to see request/response shape.')
    .option('--datasource <name>', 'grpc datasource whose resolverHints.protoRoot will be loaded')
    .option('--proto-root <dir>', 'override proto root (otherwise read from --datasource resolverHints.protoRoot)')
    .option('--service <fq>', 'restrict output to a single fully-qualified service (e.g. com.example.catalog.v1.CatalogService)')
    .option('--method <name>', 'restrict expanded messages to a single rpc method')
    .option('--max-depth <n>', 'message expansion depth cap (default 4)', '4')
    .action(async (opts) => {
      const ctx = getCtx();
      const { root, source } = resolveProtoRoot(ctx, opts);
      const maxDepth = Math.max(0, parseInt(String(opts.maxDepth || '4'), 10) || 4);
      const descriptor = await describeProtoRoot(root, {
        service: opts.service ? String(opts.service) : undefined,
        method: opts.method ? String(opts.method) : undefined,
        expand: { maxDepth },
      });
      if (ctx.jsonMode) {
        printJson({
          ok: true,
          data: descriptor,
          meta: { protoRoot: root, protoRootSource: source },
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
      console.log(renderHumanDescribe(descriptor, { service: opts.service, method: opts.method }));
    });

  grpc
    .command('list')
    .description('Alias for `grpc describe` without message expansion (services + methods only).')
    .option('--datasource <name>')
    .option('--proto-root <dir>')
    .action(async (opts) => {
      const ctx = getCtx();
      const { root, source } = resolveProtoRoot(ctx, opts);
      const descriptor = await describeProtoRoot(root, { expand: { maxDepth: 0, maxMessages: 0 } });
      const flat = descriptor.services.flatMap((s) =>
        s.methods.map((m) => ({
          service: s.name,
          method: m.name,
          request: m.requestType,
          response: m.responseType,
          streams: [m.requestStream ? 'req' : '', m.responseStream ? 'resp' : ''].filter(Boolean).join('+') || '',
        })),
      );
      if (ctx.jsonMode) {
        printJson({ ok: true, data: { methods: flat }, meta: { protoRoot: root, protoRootSource: source } });
        return;
      }
      console.log(renderTable(flat));
    });
}
