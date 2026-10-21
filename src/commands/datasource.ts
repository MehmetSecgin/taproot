import fs from 'node:fs';
import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { defaultDatasourceName, normalizeNamespace, normalizeService, runDatasourceConnectors } from '../core/app.js';
import { saveKbBootstrapCandidate } from '../core/bootstrap.js';
import { badInput } from '../core/error-classification.js';
import { nowIso } from '../core/time.js';
import { renderRecord, renderTable, printJson, printEnvelope } from '../core/output.js';
import { extractImportArray, validateImportedProfile } from '../core/datasource-import.js';
import { DoctorStatus } from '../types/core.js';
import type { Capability } from '../types/core.js';
import { str } from '../core/strings.js';

function parseHintPairs(values: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values) {
    const idx = value.indexOf('=');
    if (idx <= 0) throw badInput(`Invalid --hint '${value}'. Expected key=value.`);
    const key = value.slice(0, idx).trim();
    const val = value.slice(idx + 1);
    if (!key) throw badInput(`Invalid --hint '${value}'. Empty key.`);
    out[key] = val;
  }
  return out;
}

function parseConnectorRefPairs(values: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values) {
    const idx = value.indexOf('=');
    if (idx <= 0) throw badInput(`Invalid --connector-ref '${value}'. Expected connector=credentialRef.`);
    const connector = value.slice(0, idx).trim();
    const ref = value.slice(idx + 1).trim();
    if (!connector || !ref) throw badInput(`Invalid --connector-ref '${value}'. Expected connector=credentialRef.`);
    out[`${connector}CredentialRef`] = ref;
  }
  return out;
}

export function registerDatasource(program: Command, getCtx: () => AppContext): void {
  const ds = program.command('datasource').description('Datasource profile operations');

  ds.command('list')
    .option('--detailed', 'include confidence and updatedAt', false)
    .action((opts) => {
      const ctx = getCtx();
      const detailed = Boolean(opts.detailed);
      const rows = ctx.datasourceStore.list()
        .map((d) => {
          const row: Record<string, unknown> = {
            name: d.name,
            kind: d.kind,
            env: d.env || '',
            namespace: d.namespace || '',
            service: d.service || '',
          };
          if (detailed) {
            row.confidence = d.confidence;
            row.updatedAt = d.updatedAt;
          }
          return row;
        })
        .sort((a, b) =>
          String(a.env).localeCompare(String(b.env))
          || String(a.namespace).localeCompare(String(b.namespace))
          || String(a.service).localeCompare(String(b.service))
          || String(a.name).localeCompare(String(b.name)),
        );
      if (ctx.jsonMode) printEnvelope(true, rows);
      else console.log(renderTable(rows));
    });

  ds.command('show')
    .argument('<name>')
    .action((name: string) => {
    const ctx = getCtx();
    const item = ctx.datasourceStore.get(name);
    if (!item) throw new Error(`Datasource not found: ${name}`);
    if (ctx.jsonMode) printEnvelope(true, item);
    else {
      console.log(renderRecord({
        name: item.name,
        kind: item.kind,
        env: item.env || '',
        namespace: item.namespace || '',
        service: item.service || '',
        credentialRef: item.credentialRef,
        connectors: item.connectors || [],
        host: item.connection?.host || '',
        port: item.connection?.port || '',
        database: item.connection?.database || '',
        target: item.connection?.target || '',
        allowRead: item.policy?.allowRead,
        allowMutate: item.policy?.allowMutate,
        allowedCapabilities: item.policy?.allowedCapabilities || [],
        confidence: item.confidence,
        updatedAt: item.updatedAt,
      }));
    }
  });

  ds.command('remove').argument('<name>').action((name: string) => {
    const ctx = getCtx();
    const ok = ctx.datasourceStore.remove(name);
    if (!ok) throw new Error(`Datasource not found: ${name}`);
    if (ctx.jsonMode) printEnvelope(true, { removed: true, name });
    else console.log(`Removed datasource ${name}`);
  });

  ds.command('add')
    .requiredOption('--name <name>')
    .requiredOption('--kind <kind>')
    .requiredOption('--credential-ref <ref>')
    .option('--env <env>')
    .option('--namespace <namespace>')
    .option('--service <service>')
    .option('--host <host>')
    .option('--port <port>')
    .option('--database <db>')
    .option('--target <target>')
    .option('--ssl', 'connect over TLS (grpc: use TLS instead of plaintext h2c)', false)
    .option('--connector <name>', 'repeatable', (v, p: string[]) => (p || []).concat(v), [])
    .option('--connector-ref <name=ref>', 'repeatable connector credential refs', (v, p: string[]) => (p || []).concat(v), [])
    .option('--hint <key=value>', 'repeatable resolverHints key/value (e.g. protoRoot=/path, protoMessage=OrderProto)', (v, p: string[]) => (p || []).concat(v), [])
    .option('--openvpn-ref <ref>')
    .option('--teleport-ref <ref>')
    .option('--allow-read', 'allow read', true)
    .option('--allow-mutate', 'allow mutate', false)
    .option('--confidence <n>', 'confidence 0..1', '0.8')
    .option('--probe', 'after save, run plugin doctor() against the new profile; rollback on failure', false)
    .action(async (opts) => {
      const ctx = getCtx();
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
        credentialRef: opts.credentialRef,
        connectors: opts.connector || [],
        policy: {
          allowRead: Boolean(opts.allowRead),
          allowMutate: Boolean(opts.allowMutate),
          allowedCapabilities: opts.allowMutate
            ? (['executeRead', 'executeMutate'] satisfies Capability[])
            : (['executeRead'] satisfies Capability[]),
        },
        resolverHints: {
          ...parseConnectorRefPairs(opts.connectorRef || []),
          ...parseHintPairs(opts.hint || []),
          ...(opts.openvpnRef ? { openvpnCredentialRef: opts.openvpnRef } : {}),
          ...(opts.teleportRef ? { teleportCredentialRef: opts.teleportRef } : {}),
        },
        updatedAt: nowIso(),
        confidence: Number(opts.confidence),
      };
      const existed = Boolean(ctx.datasourceStore.get(opts.name));
      const saved = ctx.datasourceStore.save(profile);
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
            if (!existed) ctx.datasourceStore.remove(saved.name);
            const detail = connectorFailures.map((c) => `${c.check}: ${c.detail}`).join(' | ');
            throw new Error(`PROBE_FAILED: profile rolled back. ${detail}`);
          }
          const creds = await ctx.credentialStore.get(saved.credentialRef);
          const checks = await plugin.doctor({ datasource: saved, credentials: creds });
          const failures = checks.filter((c) => c.status === DoctorStatus.Fail);
          if (failures.length) {
            if (!existed) ctx.datasourceStore.remove(saved.name);
            const detail = failures.map((c) => `${c.check}: ${c.detail}`).join(' | ');
            throw new Error(`PROBE_FAILED: profile rolled back. ${detail}`);
          }
          const allChecks = [...connectorChecks, ...checks];
          if (ctx.jsonMode) printEnvelope(true, { ...saved, probe: { ok: true, checks: allChecks } });
          else {
            console.log(`Saved datasource ${saved.name} (probe ok: ${allChecks.map((c) => c.check).join(', ')})`);
          }
          return;
        } catch (err) {
          const message = (err as Error).message || String(err);
          if (message.startsWith('PROBE_FAILED') || message.startsWith('PROBE_UNSUPPORTED')) throw err;
          if (!existed) ctx.datasourceStore.remove(saved.name);
          throw new Error(`PROBE_FAILED: profile rolled back. ${message}`);
        }
      }
      if (ctx.jsonMode) printEnvelope(true, saved);
      else console.log(`Saved datasource ${saved.name}`);
    });

  ds.command('resolve')
    .requiredOption('--env <env>')
    .option('--namespace <namespace>')
    .requiredOption('--service <service>')
    .action(async (opts) => {
      const ctx = getCtx();
      const service = normalizeService(opts.service, ctx.runtimeConfigStore.serviceAliases());
      const namespace = normalizeNamespace(opts.namespace);
      const fromStore = ctx.datasourceStore.resolveByEnvService(opts.env, service, namespace || undefined);
      if (fromStore) {
        if (ctx.jsonMode) printEnvelope(true, { source: 'datasource-store', profile: fromStore });
        else {
          console.log(`source: datasource-store`);
          console.log(renderRecord({
            name: fromStore.name,
            kind: fromStore.kind,
            env: fromStore.env || '',
            namespace: fromStore.namespace || '',
            service: fromStore.service || '',
            credentialRef: fromStore.credentialRef,
            host: fromStore.connection?.host || '',
            port: fromStore.connection?.port || '',
            database: fromStore.connection?.database || '',
            target: fromStore.connection?.target || '',
          }));
        }
        return;
      }
      const kb = ctx.kbStore.resolveConnection(service, opts.env, namespace || undefined);
      if (!kb) throw new Error(`No datasource profile found for env=${opts.env}${namespace ? ` namespace=${namespace}` : ''} service=${service}`);
      const name = defaultDatasourceName(opts.env, service, str(kb.namespace || namespace).trim() || undefined);
      const profile = await saveKbBootstrapCandidate(ctx, opts.env, service, name, kb, {
        confidence: 0.85,
      });
      if (!profile) throw new Error(`KB connection could not be converted into a datasource profile for env=${opts.env}${namespace ? ` namespace=${namespace}` : ''} service=${service}`);
      if (ctx.jsonMode) printEnvelope(true, { source: 'kb', profile });
      else {
        console.log(`source: kb`);
        console.log(renderRecord({
          name: profile.name,
          kind: profile.kind,
          env: profile.env || '',
          service: profile.service || '',
          credentialRef: profile.credentialRef,
          host: profile.connection?.host || '',
          port: profile.connection?.port || '',
          database: profile.connection?.database || '',
          target: profile.connection?.target || '',
        }));
      }
    });

  ds.command('export')
    .description('Emit all datasource profiles as JSON (round-trips with `datasource import --file`)')
    .action((opts) => {
      const ctx = getCtx();
      const all = ctx.datasourceStore.list();
      if (ctx.jsonMode) printEnvelope(true, all);
      else printJson(all);
    });

  ds.command('import')
    .description('Bulk-add datasource profiles from a JSON file')
    .option('--file <path>', 'JSON array of profiles, or an object with a data/datasources array')
    .option('--credential-ref <ref>', 'credentialRef applied to imported profiles that lack one')
    .option('--dry-run', 'validate and report without saving', false)
    .action((opts) => {
      const ctx = getCtx();
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
      if (ctx.jsonMode) printEnvelope(payload.failed.length === 0, payload);
      else {
        console.log(`${opts.dryRun ? 'validated' : 'imported'} ${imported.length}/${candidates.length} profile(s)${failed.length ? `, ${failed.length} failed` : ''}`);
        for (const f of failed) console.log(`  FAIL ${f.name}: ${f.error}`);
      }
    });
}
