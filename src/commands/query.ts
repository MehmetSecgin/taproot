import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { environmentPolicy, normalizeNamespace, normalizeService } from '../core/app.js';
import { RUNTIME_CONSTANTS } from '../core/constants.js';
import { createProgress } from '../core/progress.js';
import { parseTimeoutMs } from '../core/query-timeout.js';
import { ensureStarterRuntime } from '../core/runtime-init.js';
import { str } from '../core/strings.js';
import { runDaemonQuery } from './query-daemon.js';
import { runDirectQuery } from './query-direct.js';
import type { QueryEnv, QueryOpts } from './query-types.js';

function parseDatasourceAlias(value: string | undefined, aliases: Record<string, string>): { env: string; service: string } | null {
  const raw = str(value).trim().toLowerCase();
  const m = raw.match(/^([a-z0-9]+)-([a-z0-9-]+)$/);
  if (!m) return null;
  return { env: m[1], service: normalizeService(m[2], aliases) };
}

export function registerQuery(program: Command, getCtx: () => AppContext): void {
  program
    .command('query')
    .description('Execute plugin-native query against resolved datasource')
    .option('--datasource <name>')
    .option('--env <env>')
    .option('--namespace <namespace>')
    .option('--service <service>')
    .option('--intent <intent>')
    .option('--reason <reason>')
    .option('--card <id>')
    .option('--template <id>')
    .option('--query <native>')
    .option('--sql <native>', 'alias for --query (raw native query/SQL)')
    .option('--param <key=value>', 'repeatable', (v, p: string[]) => (p || []).concat(v), [])
    .option('--allow-discovery', 'fall back to probing kubectl/teleport targets when no profile or KB entry resolves the env+service. Off by default for reproducibility.', false)
    .option('--allow-mutate', 'allow mutating query', false)
    .option('--allow-partition-scan', 'allow querying RANGE/LIST partitioned tables without partition predicates', false)
    .option('--allow-schema-introspection', 'allow SHOW CREATE/DESCRIBE/SHOW COLUMNS even when the service schema is already cached', false)
    .option('--explain', 'wrap query with EXPLAIN; reports the plan instead of running the query', false)
    .option('--full', 'render full result table even when result is large (skip auto-summary)', false)
    .option('--rows-object', 'emit rows as objects keyed by column name (legacy). Default JSON output uses compact array form paired with the columns array.', false)
    .option('--pluck <path>', 'return only the subtree at this dot-path of the JSON envelope (e.g. data.rows, data.columns, meta.schemaContext, error.details). Full record is still persisted to ~/.taproot/runs/<runId>/summary.json — use "taproot --json run show --run-id <id> --pluck <other-path>" to fetch other fields later.')
    .option('--proto <Message>', 'decode binary reply payloads as the given protobuf message (e.g. OrderProto). Used by the redis plugin; requires --proto-root or a datasource-level default in resolverHints.protoRoot.')
    .option('--proto-root <dir>', 'directory containing .proto sources used for decoding. Loaded recursively. Defaults to resolverHints.protoRoot on the datasource if set.')
    .option('--allow-flush', 'permit Redis FLUSH-tier commands (FLUSHDB/FLUSHALL/SWAPDB/MIGRATE). Required in addition to --allow-mutate. Off by default.', false)
    .option('--request-json <json>', 'gRPC plugin: request message body as JSON. Overrides --param-built payloads. Example: \'{"values":[1,2,3]}\'.')
    .option('--skip-proto-validate', 'gRPC plugin: bypass local proto schema validation of the request payload. Off by default; only use for deliberately malformed payloads (e.g. fuzzing).', false)
    .option(
      '--timeout-ms <ms>',
      `abort queries that run longer than this (default ${RUNTIME_CONSTANTS.query.defaultTimeoutMs})`,
      String(RUNTIME_CONSTANTS.query.defaultTimeoutMs),
    )
    .action(async (opts: QueryOpts) => {
      const ctx = getCtx();
      ensureStarterRuntime(ctx);
      if (opts.sql && !opts.query) opts.query = opts.sql;
      if (opts.sql && opts.query && opts.sql !== opts.query) {
        throw new Error('Invalid argument: pass either --query or --sql, not both with different values.');
      }
      const timeoutMs = parseTimeoutMs(opts.timeoutMs, RUNTIME_CONSTANTS.query.defaultTimeoutMs);
      const aliases = ctx.runtimeConfigStore.serviceAliases();
      const explicitProfile = opts.datasource ? ctx.datasourceStore.get(opts.datasource) : undefined;
      const alias = explicitProfile ? null : parseDatasourceAlias(opts.datasource, aliases);
      const env = str(opts.env || explicitProfile?.env || alias?.env).trim();
      const namespace = normalizeNamespace(str(opts.namespace || explicitProfile?.namespace));
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
      const forceDirect = process.env.TAPROOT_FORCE_DIRECT === '1' || allowDiscovery || Boolean(opts.explain);
      if (opts.explain && !opts.query) {
        throw new Error('Invalid argument: --explain requires --query (raw SQL). Resolve --card/--template/--intent first, then re-run with --query and --explain.');
      }
      const qenv: QueryEnv = {
        ctx,
        opts,
        progress,
        logVerbose,
        env,
        namespace,
        timeoutMs,
        allowDiscovery,
        explicitProfile,
        alias,
      };
      try {
        if (allowDiscovery && !ctx.jsonMode) {
          progress.update('discovery mode enabled, bypassing daemon');
        }
        progress.update(forceDirect ? 'running direct query mode' : 'attempting daemon query path');
        if (!forceDirect) {
          const outcome = await runDaemonQuery(qenv);
          if (outcome === 'handled') return;
        }
        await runDirectQuery(qenv);
      } finally {
        progress.stop();
      }
    });
}
