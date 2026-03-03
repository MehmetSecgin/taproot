import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { AppContext } from '../core/app.js';
import { classifyError, fillTemplate, normalizeService, parseParamPairs, runDatasourceConnectors } from '../core/app.js';
import { datasourceKbConflicts } from '../core/conflicts.js';
import { createRunArtifacts, writeRunSummary, appendEvent } from '../core/artifacts.js';
import { printJson, renderTable } from '../core/output.js';
import { createProgress } from '../core/progress.js';
import { enforceMutationPolicy } from '../core/safety.js';
import { nowIso } from '../core/time.js';
import { rpcCall } from '../daemon/client.js';

function rowFromArray(columns: string[], row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of columns) out[c] = row[c];
  return out;
}

function parseDatasourceAlias(value?: string): { env: string; service: string } | null {
  const raw = String(value || '').trim().toLowerCase();
  const m = raw.match(/^([a-z0-9]+)-([a-z0-9-]+)$/);
  if (!m) return null;
  return { env: m[1], service: normalizeService(m[2]) };
}

async function ensureCredentialDefaults(ctx: AppContext, ref: string, defaults: Record<string, string>, overwrite = false): Promise<void> {
  const current = await ctx.credentialStore.get(ref);
  const merged = overwrite ? { ...current, ...defaults } : { ...defaults, ...current };
  const changed = overwrite
    ? Object.keys(defaults).some((k) => current[k] !== defaults[k])
    : Object.keys(defaults).some((k) => !current[k] && defaults[k]);
  if (changed) await ctx.credentialStore.set(ref, merged);
}

async function autoBootstrapDatasource(ctx: AppContext, env: string, service: string, datasourceName: string): Promise<any | undefined> {
  const kb = ctx.kbStore.resolveConnection(service, env);
  if (!kb) return undefined;
  const accessMethod = String(kb.access_method || '').toLowerCase();
  const engine = String(kb.engine || 'mysql').toLowerCase();
  const database = String(kb.database || '');
  const dbUser = String(kb.db_user || '');
  const target = String(kb.target || '');
  const credentialRef = `${env}:${service}`;

  if (accessMethod === 'qa-portforward') {
    const namespace = String(kb.namespace || 'develop');
    const context = String(process.env.TAPROOT_QA_CONTEXT || kb.k8s_context || env || namespace);
    const localPort = Number(process.env.TAPROOT_QA_LOCAL_PORT || 4406);
    const logFile = `/tmp/taproot-pf-${env}-${service}.log`;
    const statusCommand = `lsof -iTCP:${localPort} -sTCP:LISTEN >/dev/null`;
    const connectCommand = `${statusCommand} || (svc_port=$(kubectl --context ${context} -n ${namespace} get svc/${target} -o jsonpath='{.spec.ports[0].port}' 2>/dev/null || echo 4000); nohup kubectl --context ${context} -n ${namespace} port-forward svc/${target} ${localPort}:$svc_port >${logFile} 2>&1 & for _ in 1 2 3 4 5; do ${statusCommand} && break; sleep 1; done; ${statusCommand})`;

    await ensureCredentialDefaults(ctx, credentialRef, {
      user: dbUser || 'root',
    });
    await ensureCredentialDefaults(ctx, 'vpn:work', {
      statusCommand: 'pgrep -f openvpn >/dev/null && echo connected || (echo disconnected >&2; exit 1)',
    });
    await ensureCredentialDefaults(
      ctx,
      `kpf:${env}:${service}`,
      {
      statusCommand,
      connectCommand,
      },
      true,
    );

    const profile = {
      name: datasourceName,
      kind: engine.includes('postgres') ? 'postgres' : 'mysql',
      env,
      service,
      tags: ['auto-bootstrap', 'kb-derived'],
      connection: {
        host: '127.0.0.1',
        port: localPort,
        database,
      },
      credentialRef,
      connectors: ['openvpn', 'kubectl-portforward'],
      policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
      resolverHints: {
        openvpnCredentialRef: 'vpn:work',
        'kubectl-portforwardCredentialRef': `kpf:${env}:${service}`,
      },
      updatedAt: nowIso(),
      confidence: 0.9,
    };
    return ctx.datasourceStore.save(profile as any);
  }

  if (accessMethod === 'tsh') {
    await ensureCredentialDefaults(ctx, credentialRef, {
      dbUser,
    });
    await ensureCredentialDefaults(ctx, 'vpn:work', {
      statusCommand: 'pgrep -f openvpn >/dev/null && echo connected || (echo disconnected >&2; exit 1)',
    });
    await ensureCredentialDefaults(ctx, `tsh:${env}`, {
      statusCommand: 'tsh status',
    });
    const profile = {
      name: datasourceName,
      kind: 'teleport-mysql',
      env,
      service,
      tags: ['auto-bootstrap', 'kb-derived'],
      connection: {
        database,
        target,
      },
      credentialRef,
      connectors: ['openvpn', 'teleport'],
      policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
      resolverHints: {
        openvpnCredentialRef: 'vpn:work',
        teleportCredentialRef: `tsh:${env}`,
      },
      updatedAt: nowIso(),
      confidence: 0.9,
    };
    return ctx.datasourceStore.save(profile as any);
  }

  return undefined;
}

async function promptPassword(ref: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const value = await rl.question(`Password for ${ref}: `);
    return value.trim();
  } finally {
    rl.close();
  }
}

export function registerQuery(program: Command, getCtx: () => AppContext): void {
  program
    .command('query')
    .description('Execute plugin-native query against resolved datasource')
    .option('--datasource <name>')
    .option('--env <env>')
    .option('--service <service>')
    .option('--intent <intent>')
    .option('--template <id>')
    .option('--query <native>')
    .option('--param <key=value>', 'repeatable', (v, p: string[]) => (p || []).concat(v), [])
    .option('--allow-discovery', 'allow non-deterministic datasource discovery', false)
    .option('--allow-mutate', 'allow mutating query', false)
    .action(async (opts) => {
      const ctx = getCtx();
      const progress = createProgress({
        enabled: !ctx.jsonMode && !ctx.verbose,
        noAnimations: ctx.noAnimations,
        noColor: ctx.noColor,
        verbose: ctx.verbose,
        plainUpdates: !ctx.jsonMode && process.stderr.isTTY,
      });
      const logVerbose = (msg: string): void => {
        if (!ctx.jsonMode && ctx.verbose) process.stderr.write(`[taproot] ${msg}\n`);
      };
      const forceDirect = process.env.TAPROOT_FORCE_DIRECT === '1' || Boolean(opts.allowDiscovery);
      try {
        if (opts.allowDiscovery && !ctx.jsonMode) {
          progress.update('discovery mode enabled, bypassing daemon');
        }
        progress.update(forceDirect ? 'running direct query mode' : 'attempting daemon query path');
        if (!forceDirect) {
          try {
            const rpc = await rpcCall({
              method: 'query.execute',
              params: {
                datasource: opts.datasource,
                env: opts.env,
                service: opts.service,
                intent: opts.intent,
                template: opts.template,
                query: opts.query,
                allowDiscovery: Boolean(opts.allowDiscovery),
                allowMutate: Boolean(opts.allowMutate),
                param: opts.param || [],
              },
            });
            if (rpc.ok) {
              const columns = (rpc.data?.columns as string[]) || [];
              const rows = (rpc.data?.rows as Array<Record<string, unknown>>) || [];
              const warnings = (rpc.data?.warnings as string[]) || [];
              if (ctx.jsonMode) {
                printJson({
                  ok: true,
                  data: rpc.data || {},
                  meta: { ...(rpc.meta || {}), requestId: rpc.requestId },
                });
              } else {
                progress.succeed(`query complete (${rows.length} rows)`);
                if (warnings.length) {
                  progress.warn(`warnings: ${warnings.join(' | ')}`);
                }
                logVerbose(
                  `daemon request=${rpc.requestId} session=${rpc.meta?.sessionId || 'n/a'} run=${rpc.meta?.runId || 'n/a'}`,
                );
                console.log(renderTable(rows.map((r) => rowFromArray(columns, r))));
              }
              return;
            }
            throw new Error(`${rpc.error?.code || 'GENERIC'}: ${rpc.error?.message || 'daemon query failed'}`);
          } catch (error) {
            const msg = String((error as Error).message || '');
            if (!/(ENOENT|ECONNREFUSED|EPIPE|socket hang up)/i.test(msg)) {
              progress.fail('daemon query failed');
              throw error;
            }
            progress.update('daemon unavailable, falling back to direct mode');
            logVerbose(`daemon RPC unavailable (${msg})`);
          }
        }
      let datasource = opts.datasource ? ctx.datasourceStore.get(opts.datasource) : undefined;
      const alias = parseDatasourceAlias(opts.datasource);
      const env = String(opts.env || alias?.env || '').trim();
      const isProd = env === 'prod';
      const service = normalizeService(opts.service || alias?.service || '');
      progress.update(`resolving datasource (${opts.datasource || `${env}-${service || 'unknown'}`})`);
      let resolutionSource: 'explicit' | 'store' | 'learning' | 'kb' | 'unknown' = datasource ? 'explicit' : 'unknown';
      if (!datasource && opts.env && service) {
        datasource = ctx.datasourceStore.resolveByEnvService(opts.env, service);
        if (datasource) resolutionSource = 'store';
      }
      if (!datasource && env && service) {
        datasource = ctx.datasourceStore.resolveByEnvService(env, service);
        if (datasource) resolutionSource = 'store';
      }
      if (!datasource && env && service && (!isProd || Boolean(opts.allowDiscovery))) {
        const learned = ctx.learningStore.resolveConnection(env, service);
        if (learned) {
          datasource = ctx.datasourceStore.save({
            name: learned.datasourceName,
            kind: learned.kind,
            env: learned.env,
            service: learned.service,
            tags: ['learning-derived'],
            connection: learned.connection,
            credentialRef: learned.credentialRef,
            connectors: learned.connectors,
            policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
            resolverHints: learned.resolverHints || {},
            updatedAt: new Date().toISOString(),
            confidence: learned.confidence,
          } as any);
          resolutionSource = 'learning';
        }
      }
      if (!datasource && env && service) {
        datasource = await autoBootstrapDatasource(ctx, env, service, opts.datasource || `${env}-${service}`);
        if (datasource) {
          resolutionSource = 'kb';
          logVerbose(`auto-bootstrapped datasource from KB (${datasource.name})`);
        }
      }
      if (
        datasource &&
        env &&
        service &&
        datasource.name === (opts.datasource || datasource.name) &&
        Array.isArray((datasource as any).tags) &&
        (datasource as any).tags.includes('auto-bootstrap')
      ) {
        datasource = await autoBootstrapDatasource(ctx, env, service, datasource.name);
      }
      if (!datasource && isProd && !opts.allowDiscovery) {
        throw new Error('DETERMINISTIC_REQUIRED: prod requires deterministic datasource resolution from profile or KB. Use --datasource or --env+--service.');
      }
      if (!datasource) throw new Error('Datasource resolution failed. Use --datasource or --env+--service.');
      if (isProd && !opts.allowDiscovery && resolutionSource === 'learning') {
        throw new Error('DETERMINISTIC_REQUIRED: prod requires KB/profile-backed datasource resolution. Retry without discovery cache or set --allow-discovery.');
      }
      const warnings: string[] = [];
      if (env && service) {
        const kb = ctx.kbStore.resolveConnection(service, env);
        if (kb) {
          const conflicts = datasourceKbConflicts(datasource as any, kb);
          if (conflicts.length) {
            const warning = `datasource overrides KB (${conflicts.join('; ')})`;
            warnings.push(warning);
            logVerbose(`warning: ${warning}`);
          }
        }
      }
      progress.update(`datasource ready (${datasource.name})`);

      let query = (opts.query || '').trim();
      const params = parseParamPairs(opts.param || []);
      if (!query && opts.template) {
        const tpl = ctx.templateStore.get(opts.template);
        if (!tpl) throw new Error(`Template not found: ${opts.template}`);
        query = fillTemplate(tpl.nativeQueryTemplate, params);
      }
      if (!query && opts.intent) {
        const learned = ctx.learningStore.resolveQueryTemplate(service || datasource.service || '', opts.intent);
        const tpl =
          (learned ? { nativeQueryTemplate: learned.sqlTemplate } : null) ||
          ctx.kbStore.resolveQuery(service || datasource.service || '', opts.intent) ||
          ctx.templateStore.resolveByIntent({ datasourceName: datasource.name, datasourceKind: datasource.kind, intent: opts.intent });
        if (tpl) query = fillTemplate(String((tpl as any).nativeQueryTemplate), params);
      }
      if (!query) throw new Error('No query resolved. Provide --query, --template, or --intent.');
      progress.update('query resolved');

      enforceMutationPolicy({ sql: query, allowMutate: Boolean(opts.allowMutate), datasource: datasource as any });
      const capability = opts.allowMutate ? 'executeMutate' : 'executeRead';
      const plugin = ctx.pluginRegistry.get(datasource.kind);
      if (!plugin?.execute) throw new Error(`No execute-capable plugin for datasource kind '${datasource.kind}'.`);
      if (!plugin.manifest.capabilities.includes(capability as any)) {
        throw new Error(`Plugin '${plugin.manifest.name}' does not support capability ${capability}.`);
      }

      let creds = await ctx.credentialStore.get(datasource.credentialRef);
      const artifacts = createRunArtifacts(ctx.paths.runsDir, datasource.name.replace(/[^a-z0-9-]/gi, '-'));
      appendEvent(artifacts.runDir, `query started capability=${capability}`);
      try {
        progress.update('checking connectors');
        const connectorChecks = await runDatasourceConnectors({
          datasource: datasource as any,
          credentialStore: ctx.credentialStore,
          pluginRegistry: ctx.pluginRegistry,
          mode: 'connect',
        });
        for (const c of connectorChecks) appendEvent(artifacts.runDir, `connector ${c.check} ${c.status}: ${c.detail}`);
        for (const c of connectorChecks) logVerbose(`connector ${c.check}: ${c.status}`);
        if (connectorChecks.some((c) => c.status === 'fail')) {
          throw new Error(`connector preflight failed: ${connectorChecks.filter((c) => c.status === 'fail').map((c) => c.detail).join(' | ')}`);
        }
        progress.update(`executing query via ${plugin.manifest.name}`);
        let result;
        try {
          result = await plugin.execute(
            {
              datasource: datasource as any,
              query,
              capability: capability as any,
            },
            creds,
          );
        } catch (err) {
          const message = (err as Error).message || '';
          const code = classifyError(message);
          const canPromptPassword =
            code === 'ACCESS_DENIED' &&
            !creds.password &&
            !ctx.jsonMode &&
            input.isTTY &&
            !process.env.CI &&
            (datasource.kind === 'mysql' || datasource.kind === 'postgres');
          if (!canPromptPassword) throw err;
          progress.update(`password required for ${datasource.credentialRef}`);
          progress.stop();
          const password = await promptPassword(datasource.credentialRef);
          if (!password) throw err;
          creds = { ...creds, password };
          await ctx.credentialStore.set(datasource.credentialRef, creds);
          progress.update('retrying query');
          result = await plugin.execute(
            {
              datasource: datasource as any,
              query,
              capability: capability as any,
            },
            creds,
          );
        }
        result.runId = artifacts.runId;
        writeRunSummary(artifacts.runDir, result);
        appendEvent(artifacts.runDir, 'query succeeded');

        ctx.learningStore.saveSuccess({ datasource: datasource as any, queryIntent: opts.intent, sql: query, result });
        if (warnings.length) result.warnings = [...result.warnings, ...warnings];
        progress.succeed(`query complete (${result.result.rows.length} rows, ${result.timings.durationMs}ms)`);

        if (ctx.jsonMode) printJson(result);
        else console.log(renderTable(result.result.rows.map((r) => rowFromArray(result.result.columns, r))));
        } catch (error) {
          const message = (error as Error).message;
          const code = classifyError(message);
          appendEvent(artifacts.runDir, `query failed code=${code} message=${message}`);
          progress.fail(`query failed (${code})`);
          ctx.learningStore.saveFailure({
            datasource: datasource as any,
            queryIntent: opts.intent,
            sql: query,
            errorClass: code,
          });
          throw new Error(`${code}: ${message}`);
        }
      } finally {
        progress.stop();
      }
    });
}
