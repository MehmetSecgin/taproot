import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { AppContext } from '../core/app.js';
import { classifyError, environmentPolicy, fillTemplate, normalizeService, parseParamPairs, runDatasourceConnectors } from '../core/app.js';
import { criticalDatasourceKbConflicts, datasourceKbConflicts } from '../core/conflicts.js';
import { discoverKubernetesTargets, discoverTeleportTargets, inferDatabaseCandidates } from '../core/discovery.js';
import { exitCodeForClass } from '../core/exit-codes.js';
import { createRunArtifacts, writeRunSummary, appendEvent } from '../core/artifacts.js';
import { bootstrapDatasource, saveKbBootstrapCandidate } from '../core/bootstrap.js';
import { printJson, renderTable } from '../core/output.js';
import { createProgress } from '../core/progress.js';
import { enforceMutationPolicy } from '../core/safety.js';
import { RUNTIME_CONSTANTS } from '../core/constants.js';
import { parseTimeoutMs, withQueryTimeout } from '../core/query-timeout.js';
import { rpcCall } from '../daemon/client.js';

function rowFromArray(columns: string[], row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of columns) out[c] = row[c];
  return out;
}

function parseDatasourceAlias(value: string | undefined, aliases: Record<string, string>): { env: string; service: string } | null {
  const raw = String(value || '').trim().toLowerCase();
  const m = raw.match(/^([a-z0-9]+)-([a-z0-9-]+)$/);
  if (!m) return null;
  return { env: m[1], service: normalizeService(m[2], aliases) };
}

function preferredAccessMethods(ctx: AppContext, env: string, kbAccessMethod?: string): string[] {
  const policy = environmentPolicy(ctx, env);
  const out = [...policy.preferredAccessMethods];
  if (kbAccessMethod && !out.includes(kbAccessMethod)) out.push(kbAccessMethod);
  return out.filter(Boolean);
}

function discoverTargets(ctx: AppContext, input: { env: string; service: string; accessMethods: string[]; namespace?: string }): string[] {
  const policy = environmentPolicy(ctx, input.env);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const method of input.accessMethods) {
    const current = String(method || '').trim().toLowerCase();
    let next: string[] = [];
    if (current === 'qa-portforward') {
      next = discoverKubernetesTargets(String(input.namespace || 'default'), input.service, input.env, policy);
    } else if (current === 'tsh') {
      next = discoverTeleportTargets(input.service, input.env, policy);
    }
    for (const target of next) {
      if (seen.has(target)) continue;
      seen.add(target);
      out.push(target);
    }
  }
  return out;
}

function misconfiguredDatasourceError(datasourceName: string, env: string, service: string, conflicts: string[]): Error {
  return new Error(
    `MISCONFIGURED_DATASOURCE: datasource '${datasourceName}' conflicts with KB for env=${env} service=${service} (${conflicts.join('; ')}). Datasource store blocks KB-backed execution until the profile is repaired.`,
  );
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
    .option(
      '--timeout-ms <ms>',
      `abort queries that run longer than this (default ${RUNTIME_CONSTANTS.query.defaultTimeoutMs})`,
      String(RUNTIME_CONSTANTS.query.defaultTimeoutMs),
    )
    .action(async (opts) => {
      const ctx = getCtx();
      const timeoutMs = parseTimeoutMs(opts.timeoutMs, RUNTIME_CONSTANTS.query.defaultTimeoutMs);
      const aliases = ctx.runtimeConfigStore.serviceAliases();
      const alias = parseDatasourceAlias(opts.datasource, aliases);
      const env = String(opts.env || alias?.env || '').trim();
      const policy = environmentPolicy(ctx, env);
      const allowDiscovery = Boolean(opts.allowDiscovery) || policy.allowDiscoveryByDefault;
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
      const forceDirect = process.env.TAPROOT_FORCE_DIRECT === '1' || allowDiscovery;
      try {
        if (allowDiscovery && !ctx.jsonMode) {
          progress.update('discovery mode enabled, bypassing daemon');
        }
        progress.update(forceDirect ? 'running direct query mode' : 'attempting daemon query path');
        if (!forceDirect) {
          try {
            const rpc = await rpcCall({
              timeoutMs: Math.max(RUNTIME_CONSTANTS.rpc.requestTimeoutMs, timeoutMs + 1000),
              method: 'query.execute',
              params: {
                datasource: opts.datasource,
                env: opts.env,
                service: opts.service,
                intent: opts.intent,
                template: opts.template,
                query: opts.query,
                allowDiscovery,
                allowMutate: Boolean(opts.allowMutate),
                timeoutMs,
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
            const code = rpc.error?.code || 'GENERIC';
            const message = rpc.error?.message || 'daemon query failed';
            if (ctx.jsonMode) {
              printJson({
                ok: false,
                error: { code, message, details: rpc.error?.details },
                meta: { ...(rpc.meta || {}), requestId: rpc.requestId },
              });
              process.exitCode = exitCodeForClass(code);
              return;
            }
            throw new Error(`${code}: ${message}`);
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
      const service = normalizeService(opts.service || alias?.service || '', aliases);
      progress.update(`resolving datasource (${opts.datasource || `${env}-${service || 'unknown'}`})`);
      let resolutionSource: 'explicit' | 'store' | 'learning' | 'kb' | 'unknown' = datasource ? 'explicit' : 'unknown';
      const deterministicRequired = policy.deterministicRequired;
      if (!datasource && opts.env && service) {
        datasource = ctx.datasourceStore.resolveByEnvService(opts.env, service);
        if (datasource) resolutionSource = 'store';
      }
      if (!datasource && env && service) {
        datasource = ctx.datasourceStore.resolveByEnvService(env, service);
        if (datasource) resolutionSource = 'store';
      }
      if (!datasource && env && service && (!deterministicRequired || allowDiscovery)) {
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
        datasource = (await bootstrapDatasource(ctx, env, service, opts.datasource || `${env}-${service}`))?.profile;
        if (datasource) {
          resolutionSource = 'kb';
          logVerbose(`auto-bootstrapped datasource from KB (${datasource.name})`);
        }
      }
      if (!datasource && env && service && allowDiscovery) {
        const kb = ctx.kbStore.resolveConnection(service, env);
        const kbAccessMethod = String(kb?.access_method || '').trim().toLowerCase();
        const namespace = String(kb?.namespace || 'develop');
        const accessMethods = preferredAccessMethods(ctx, env, kbAccessMethod);
        const targets = discoverTargets(ctx, { env, service, accessMethods, namespace });
        if (targets.length) {
          const target = targets[0];
          const engine = policy.targetPreference.find((item) => target.toLowerCase().includes(item.toLowerCase())) || (String(kb?.engine || 'mysql').toLowerCase().includes('postgres') ? 'postgres' : 'mysql');
          const database = String(kb?.database || inferDatabaseCandidates(service)[0] || '');
          const dbUser = String(kb?.db_user || '');
          const accessMethod = accessMethods[0] || kbAccessMethod;
          const syntheticKb = {
            access_method: accessMethod,
            engine,
            database,
            db_user: dbUser,
            target,
            namespace,
            ...(kb || {}),
          };
          if (accessMethod === 'tsh') {
            datasource = await saveKbBootstrapCandidate(ctx, env, service, opts.datasource || `${env}-${service}`, syntheticKb, {
              targetOverride: target,
              tags: ['discovery-derived'],
              confidence: 0.6,
            });
            resolutionSource = 'kb';
          } else if (accessMethod === 'qa-portforward') {
            datasource = await saveKbBootstrapCandidate(ctx, env, service, opts.datasource || `${env}-${service}`, syntheticKb, {
              targetOverride: target,
              tags: ['discovery-derived'],
              confidence: 0.6,
            });
            resolutionSource = 'kb';
          }
        }
      }
      if (!datasource && deterministicRequired && !allowDiscovery) {
        throw new Error(`DETERMINISTIC_REQUIRED: environment '${env || 'unknown'}' requires deterministic datasource resolution from profile or KB. Use --datasource or --env+--service.`);
      }
      if (!datasource) throw new Error('Datasource resolution failed. Use --datasource or --env+--service.');
      if (deterministicRequired && !allowDiscovery && resolutionSource === 'learning') {
        throw new Error(`DETERMINISTIC_REQUIRED: environment '${env || 'unknown'}' requires KB/profile-backed datasource resolution. Retry without discovery cache or enable discovery in config or CLI.`);
      }
      const warnings: string[] = [];
      if (env && service) {
        const kb = ctx.kbStore.resolveConnection(service, env);
        if (kb) {
          const critical = criticalDatasourceKbConflicts(datasource as any, kb);
          if (critical.length) {
            throw misconfiguredDatasourceError(datasource.name, env, service, critical);
          }
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
      const execute = plugin.execute;
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
          result = await withQueryTimeout({
            timeoutMs,
            run: () =>
              execute(
                {
                  datasource: datasource as any,
                  query,
                  capability: capability as any,
                  timeoutMs,
                },
                creds,
              ),
          });
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
          result = await withQueryTimeout({
            timeoutMs,
            run: () =>
              execute(
                {
                  datasource: datasource as any,
                  query,
                  capability: capability as any,
                  timeoutMs,
                },
                creds,
              ),
          });
        }
        result.runId = artifacts.runId;
        writeRunSummary(artifacts.runDir, result);
        appendEvent(artifacts.runDir, 'query succeeded');

        ctx.learningStore.saveSuccess({ datasource: datasource as any, queryIntent: opts.intent, sql: query, result });
        if (warnings.length) result.warnings = [...result.warnings, ...warnings];
        result.resolved = {
          source: resolutionSource,
          env,
          service,
          accessMethod: String(ctx.kbStore.resolveConnection(service, env)?.access_method || ''),
          target: String(datasource.connection.target || ''),
          database: String(datasource.connection.database || ''),
          engine: datasource.kind,
        };
        progress.succeed(`query complete (${result.result.rows.length} rows, ${result.timings.durationMs}ms)`);

        if (ctx.jsonMode) printJson(result);
        else {
          console.log(`resolved via=${resolutionSource} env=${env || ''} service=${service || ''} engine=${datasource.kind} target=${String(datasource.connection.target || '')} database=${String(datasource.connection.database || '')}`);
          console.log(renderTable(result.result.rows.map((r) => rowFromArray(result.result.columns, r))));
        }
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
