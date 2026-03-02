import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { defaultDatasourceName, normalizeService } from '../core/app.js';
import { nowIso } from '../core/time.js';
import { renderTable, printJson } from '../core/output.js';

function parseConnectorRefPairs(values: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values) {
    const idx = value.indexOf('=');
    if (idx <= 0) throw new Error(`Invalid --connector-ref '${value}'. Expected connector=credentialRef.`);
    const connector = value.slice(0, idx).trim();
    const ref = value.slice(idx + 1).trim();
    if (!connector || !ref) throw new Error(`Invalid --connector-ref '${value}'. Expected connector=credentialRef.`);
    out[`${connector}CredentialRef`] = ref;
  }
  return out;
}

export function registerDatasource(program: Command, getCtx: () => AppContext): void {
  const ds = program.command('datasource').description('Datasource profile operations');

  ds.command('list').action(() => {
    const ctx = getCtx();
    const rows = ctx.datasourceStore.list().map((d) => ({
      name: d.name,
      kind: d.kind,
      env: d.env || '',
      service: d.service || '',
      confidence: d.confidence,
      updatedAt: d.updatedAt,
    }));
    if (ctx.jsonMode) printJson(rows);
    else console.log(renderTable(rows));
  });

  ds.command('show').requiredOption('--name <name>').action((opts) => {
    const ctx = getCtx();
    const item = ctx.datasourceStore.get(opts.name);
    if (!item) throw new Error(`Datasource not found: ${opts.name}`);
    printJson(item);
  });

  ds.command('remove').requiredOption('--name <name>').action((opts) => {
    const ctx = getCtx();
    const ok = ctx.datasourceStore.remove(opts.name);
    if (!ok) throw new Error(`Datasource not found: ${opts.name}`);
    if (ctx.jsonMode) printJson({ removed: true, name: opts.name });
    else console.log(`Removed datasource ${opts.name}`);
  });

  ds.command('add')
    .requiredOption('--name <name>')
    .requiredOption('--kind <kind>')
    .requiredOption('--credential-ref <ref>')
    .option('--env <env>')
    .option('--service <service>')
    .option('--host <host>')
    .option('--port <port>')
    .option('--database <db>')
    .option('--target <target>')
    .option('--connector <name>', 'repeatable', (v, p: string[]) => (p || []).concat(v), [])
    .option('--connector-ref <name=ref>', 'repeatable connector credential refs', (v, p: string[]) => (p || []).concat(v), [])
    .option('--openvpn-ref <ref>')
    .option('--teleport-ref <ref>')
    .option('--allow-read', 'allow read', true)
    .option('--allow-mutate', 'allow mutate', false)
    .option('--confidence <n>', 'confidence 0..1', '0.8')
    .action((opts) => {
      const ctx = getCtx();
      const profile = {
        name: opts.name,
        kind: opts.kind,
        env: opts.env,
        service: opts.service ? normalizeService(opts.service) : undefined,
        tags: [],
        connection: {
          host: opts.host,
          port: opts.port ? Number(opts.port) : undefined,
          database: opts.database,
          target: opts.target,
        },
        credentialRef: opts.credentialRef,
        connectors: opts.connector || [],
        policy: {
          allowRead: Boolean(opts.allowRead),
          allowMutate: Boolean(opts.allowMutate),
          allowedCapabilities: opts.allowMutate ? ['executeRead', 'executeMutate'] : ['executeRead'],
        },
        resolverHints: {
          ...parseConnectorRefPairs(opts.connectorRef || []),
          ...(opts.openvpnRef ? { openvpnCredentialRef: opts.openvpnRef } : {}),
          ...(opts.teleportRef ? { teleportCredentialRef: opts.teleportRef } : {}),
        },
        updatedAt: nowIso(),
        confidence: Number(opts.confidence),
      };
      const saved = ctx.datasourceStore.save(profile as any);
      if (ctx.jsonMode) printJson(saved);
      else console.log(`Saved datasource ${saved.name}`);
    });

  ds.command('resolve')
    .requiredOption('--env <env>')
    .requiredOption('--service <service>')
    .action((opts) => {
      const ctx = getCtx();
      const service = normalizeService(opts.service);
      const fromStore = ctx.datasourceStore.resolveByEnvService(opts.env, service);
      if (fromStore) return printJson({ source: 'datasource-store', profile: fromStore });
      const kb = ctx.kbStore.resolveConnection(service, opts.env);
      if (!kb) throw new Error(`No datasource profile found for env=${opts.env} service=${service}`);
      const name = defaultDatasourceName(opts.env, service);
      const profile = {
        name,
        kind: String(kb.engine || 'mysql').toLowerCase().includes('postgres') ? 'postgres' : 'mysql',
        env: opts.env,
        service,
        tags: ['kb-derived'],
        connection: {
          host: kb.host as string | undefined,
          port: kb.port as number | undefined,
          database: kb.database as string | undefined,
          target: kb.target as string | undefined,
        },
        credentialRef: `${opts.env}:${service}`,
        connectors: [],
        policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
        resolverHints: {},
        updatedAt: nowIso(),
        confidence: 0.85,
      };
      ctx.datasourceStore.save(profile as any);
      printJson({ source: 'kb', profile });
    });
}
