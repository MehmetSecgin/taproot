import fs from 'node:fs';
import { hasDatabase } from '../plugins-builtins/redis/index.js';
import { Command } from 'commander';
import type { LocalExecutor } from '../cli/types.js';
import { datasourceGroup } from './datasource-list.js';
import { saveKbBootstrapCandidate } from '../core/bootstrap.js';
import { runDatasourceConnectors } from '../core/connector-runner.js';
import { badInput } from '../core/error-classification.js';
import { parseKeyValuePairs } from '../core/key-value.js';
import { defaultDatasourceName, normalizeNamespace, normalizeService } from '../core/naming.js';
import { nowIso } from '../core/time.js';
import { printEnvelope } from '../core/output.js';
import { extractImportArray, validateImportedProfile } from '../core/datasource-import.js';
import { kbConnectionRows, kbProfileDraft } from '../core/kb-sync.js';
import { DoctorStatus } from '../types/core.js';
import type { Capability } from '../types/core.js';
import { str } from '../core/strings.js';
import { parseDatasourceProfile } from '../store/schemas.js';

function probeFailed(name: string, detail: string): Error {
  const rerun = `taproot doctor --datasource ${name} --connect`;
  const remove = `taproot datasource remove ${name}`;
  return new Error(`PROBE_FAILED: profile ${name} saved, probe failed. ${detail}. Re-run: ${rerun}. Remove: ${remove}`);
}

function connectorCredentialRefHints(values: string[]): Record<string, string> {
  const refs = Object.entries(parseKeyValuePairs('--connector-ref', values));
  return Object.fromEntries(refs.map(([connector, ref]) => [`${connector}CredentialRef`, ref.trim()]));
}

export function datasourceAdminCommand(program: Command, executor: LocalExecutor): void {
  const ds = datasourceGroup(program);

  ds.command('show')
    .description('Print one datasource profile')
    .argument('<name>')
    .action((name: string) => {
    const ctx = executor.context();
    const item = ctx.datasourceStore.get(name);
    if (!item) throw new Error(`Datasource not found: ${name}`);
    printEnvelope(true, item);
  });

  ds.command('remove').description('Delete a datasource profile').argument('<name>').action((name: string) => {
    const ctx = executor.context();
    const ok = ctx.datasourceStore.remove(name);
    if (!ok) throw new Error(`Datasource not found: ${name}`);
    printEnvelope(true, { removed: true, name });
  });

  ds.command('add')
    .description('Save a datasource profile; re-running with the same --name replaces it')
    .requiredOption('--name <name>', 'profile name, by convention <env>-<service>[-<namespace>]')
    .requiredOption('--kind <kind>', 'mysql, teleport-mysql, redis or grpc')
    .option('--credential-ref <ref>', 'defaults to --env')
    .option('--env <env>', 'environment (e.g. qa, stg)')
    .option('--namespace <namespace>', 'namespace within the environment (e.g. develop)')
    .option('--service <service>', 'service name')
    .option('--host <host>', 'hostname')
    .option('--port <port>', 'port')
    .option('--database <db>', 'database name (redis: database number)')
    .option('--target <target>', 'Teleport database name (teleport-mysql)')
    .option('--ssl', 'connect over TLS (grpc: use TLS instead of plaintext h2c)', false)
    .option('--connector <name>', 'repeatable', (v, p: string[]) => (p || []).concat(v), [])
    .option('--connector-ref <name=ref>', 'repeatable connector credential refs', (v, p: string[]) => (p || []).concat(v), [])
    .option('--hint <key=value>', 'repeatable resolverHints key=value: protoRoot=<dir>[,<dir>] (grpc, redis), protoMessage=<Message> (redis), probeService=<pkg.Service> and metadata.<key>=<value> (grpc), timeZone=<offset|IANA name> (mysql), dbUser=<user> (teleport-mysql)', (v, p: string[]) => (p || []).concat(v), [])
    .option('--teleport-ref <ref>', 'shorthand for --connector-ref teleport=<ref>')
    .option('--allow-read', 'allow read', true)
    .option('--allow-mutate', 'allow mutate', false)
    .option('--strict-keyspace', 'redis: refuse KEYS unless --allow-keys, and require SCAN to carry COUNT (max 200)', false)
    .option('--require-database', 'redis: refuse queries when --database is unset instead of falling back to database 0', false)
    .option('--confidence <n>', 'confidence 0..1', '0.8')
    .option('--probe', 'after save, run plugin doctor() against the new profile; the profile stays saved on failure', false)
    .action(async (opts) => {
      const ctx = executor.context();
      if (opts.requireDatabase && !hasDatabase(opts.database)) throw badInput('--require-database needs --database <n>; without it every query on this datasource would fail.');
      const credentialRef = opts.credentialRef || opts.env;
      if (!credentialRef) throw badInput('datasource add needs --env or --credential-ref; the credential ref defaults to --env.');
      const profile = {
        name: opts.name,
        kind: opts.kind,
        env: opts.env,
        namespace: opts.namespace ? normalizeNamespace(opts.namespace) : undefined,
        service: opts.service ? normalizeService(opts.service, ctx.runtimeConfigStore.serviceAliases()) : undefined,
        tags: [],
        connection: {
          host: opts.host,
          port: opts.port ? Number(opts.port) : undefined,
          database: opts.database,
          target: opts.target,
          ssl: Boolean(opts.ssl),
        },
        credentialRef,
        connectors: opts.connector || [],
        policy: {
          allowRead: Boolean(opts.allowRead),
          allowMutate: Boolean(opts.allowMutate),
          allowedCapabilities: opts.allowMutate
            ? (['executeRead', 'executeMutate'] satisfies Capability[])
            : (['executeRead'] satisfies Capability[]),
          ...(opts.requireDatabase ? { requireDatabase: true } : {}),
          ...(opts.strictKeyspace ? { strictKeyspace: true } : {}),
        },
        resolverHints: {
          ...connectorCredentialRefHints(opts.connectorRef || []),
          ...parseKeyValuePairs('--hint', opts.hint || []),
          ...(opts.teleportRef ? { teleportCredentialRef: opts.teleportRef } : {}),
        },
        updatedAt: nowIso(),
        confidence: Number(opts.confidence),
      };
      const validated = parseDatasourceProfile(profile);
      if (!validated.ok) throw badInput(`Invalid datasource ${opts.name}: ${validated.error}`);
      const existed = Boolean(ctx.datasourceStore.get(opts.name));
      const saved = ctx.datasourceStore.save(validated.profile);
      if (opts.probe) {
        const plugin = ctx.pluginRegistry.get(saved.kind);
        if (!plugin?.doctor) {
          if (!existed) ctx.datasourceStore.remove(saved.name);
          throw new Error(`PROBE_UNSUPPORTED: plugin '${saved.kind}' does not implement doctor(); cannot probe.`);
        }
        try {
          const connectorChecks = await runDatasourceConnectors({
            datasource: saved,
            credentialStore: ctx.credentialStore,
            pluginRegistry: ctx.pluginRegistry,
            mode: 'connect',
          });
          const connectorFailures = connectorChecks.filter((c) => c.status === DoctorStatus.Fail);
          if (connectorFailures.length) {
            throw probeFailed(saved.name, connectorFailures.map((c) => `${c.check}: ${c.detail}`).join(' | '));
          }
          const creds = await ctx.credentialStore.get(saved.credentialRef);
          const checks = await plugin.doctor({ datasource: saved, credentials: creds });
          const failures = checks.filter((c) => c.status === DoctorStatus.Fail);
          if (failures.length) {
            throw probeFailed(saved.name, failures.map((c) => `${c.check}: ${c.detail}`).join(' | '));
          }
          const allChecks = [...connectorChecks, ...checks];
          printEnvelope(true, { ...saved, probe: { ok: true, checks: allChecks } });
          return;
        } catch (err) {
          const message = (err as Error).message || String(err);
          if (message.startsWith('PROBE_FAILED') || message.startsWith('PROBE_UNSUPPORTED')) throw err;
          throw probeFailed(saved.name, message);
        }
      }
      printEnvelope(true, saved);
    });

  ds.command('resolve')
    .description('Find the datasource profile for an env and service')
    .requiredOption('--env <env>', 'environment (e.g. qa, stg)')
    .option('--namespace <namespace>', 'namespace within the environment (e.g. develop)')
    .requiredOption('--service <service>', 'service name')
    .action(async (opts) => {
      const ctx = executor.context();
      const service = normalizeService(opts.service, ctx.runtimeConfigStore.serviceAliases());
      const namespace = normalizeNamespace(opts.namespace);
      const fromStore = ctx.datasourceStore.resolveByEnvService(opts.env, service, namespace || undefined);
      if (fromStore) {
        printEnvelope(true, { source: 'datasource-store', profile: fromStore });
        return;
      }
      const kb = ctx.kbStore.resolveConnection(service, opts.env, namespace || undefined);
      if (!kb) throw new Error(`No datasource profile found for env=${opts.env}${namespace ? ` namespace=${namespace}` : ''} service=${service}`);
      const name = defaultDatasourceName(opts.env, service, str(kb.namespace || namespace).trim() || undefined);
      const profile = await saveKbBootstrapCandidate(ctx, opts.env, service, name, kb, {
        confidence: 0.85,
      });
      if (!profile) throw new Error(`KB connection could not be converted into a datasource profile for env=${opts.env}${namespace ? ` namespace=${namespace}` : ''} service=${service}`);
      printEnvelope(true, { source: 'kb', profile });
    });

  ds.command('import')
    .description('Bulk-add datasource profiles from a JSON file')
    .option('--file <path>', 'JSON array of profiles, or an object with a data/datasources array')
    .option('--credential-ref <ref>', 'credentialRef applied to imported profiles that lack one')
    .option('--dry-run', 'validate and report without saving', false)
    .action((opts) => {
      const ctx = executor.context();
      if (!opts.file) throw badInput('Specify --file <path>.');
      const candidates = extractImportArray(JSON.parse(fs.readFileSync(String(opts.file), 'utf8')));

      const imported: string[] = [];
      const failed: Array<{ name: string; error: string }> = [];
      for (const raw of candidates) {
        const result = validateImportedProfile(raw, { credentialRef: opts.credentialRef ? String(opts.credentialRef) : undefined });
        if (!result.ok) {
          failed.push({ name: str((raw as Record<string, unknown>)?.name) || '(unknown)', error: result.error });
          continue;
        }
        if (!opts.dryRun) ctx.datasourceStore.save(result.profile);
        imported.push(result.profile.name);
      }

      const payload = { total: candidates.length, imported, failed, dryRun: Boolean(opts.dryRun) };
      printEnvelope(payload.failed.length === 0, payload);
    });

  ds.command('sync')
    .description('Create datasource profiles for one environment from the KB; existing profiles are never overwritten')
    .option('--from-kb', 'source: the KB services.json', false)
    .option('--env <env>', 'environment to sync (e.g. qa, stg)')
    .option('--dry-run', 'report the profiles without saving', false)
    .action((opts) => {
      const ctx = getCtx();
      if (!opts.fromKb) throw badInput('Specify --from-kb; it is the only source.');
      const env = str(opts.env).trim();
      if (!env) throw badInput('datasource sync needs --env <env>.');
      const created: string[] = [];
      const skipped: Array<{ name: string; reason: string }> = [];
      for (const row of kbConnectionRows(ctx.kbStore, env)) {
        const name = defaultDatasourceName(env, row.service, row.namespace);
        if (ctx.datasourceStore.get(name)) {
          skipped.push({ name, reason: 'exists; not overwritten' });
          continue;
        }
        const draft = kbProfileDraft(env, row);
        if (!draft.ok) {
          skipped.push({ name, reason: draft.reason });
          continue;
        }
        const validated = parseDatasourceProfile({
          name,
          kind: draft.kind,
          env,
          namespace: row.namespace,
          service: row.service,
          tags: [],
          connection: draft.connection,
          credentialRef: env,
          connectors: [],
          policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
          resolverHints: draft.resolverHints,
          updatedAt: nowIso(),
          confidence: 0.8,
        });
        if (!validated.ok) {
          skipped.push({ name, reason: validated.error });
          continue;
        }
        if (!opts.dryRun) ctx.datasourceStore.save(validated.profile);
        created.push(name);
      }
      printEnvelope(true, { env, created, skipped, dryRun: Boolean(opts.dryRun) });
    });
}
