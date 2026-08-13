import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { environmentPolicy } from '../core/app.js';
import { RUNTIME_CONSTANTS } from '../core/constants.js';
import { deriveQueryTarget } from '../core/execute-query.js';
import type { QueryExecutionRequest } from '../core/execute-query.js';
import { createProgress } from '../core/progress.js';
import { parseTimeoutMs } from '../core/query-timeout.js';
import { ensureStarterRuntime } from '../core/runtime-init.js';
import { runDaemonQuery } from './query-daemon.js';
import { runDirectQuery } from './query-direct.js';
import { queryRoute } from './query-route.js';
import type { QueryOpts } from './query-types.js';

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
      '--timeout <ms>',
      `abort queries that run longer than this (default ${RUNTIME_CONSTANTS.query.defaultTimeoutMs}; overridable via defaults.query.timeoutMs in runtime config)`,
    )
    .option('--timeout-ms <ms>', 'deprecated alias for --timeout')
    .option(
      '--tz <offset|name>',
      'session time zone for WHERE timestamp literals and rendered TIMESTAMP columns. Defaults to UTC (+00:00). Accepts an offset (e.g. +05:30) or IANA name (e.g. Europe/Berlin).',
    )
    .option(
      '--json-extract <column:dotpath>',
      'extract a value from a raw JSON column client-side after fetching, adding a derived "<column>.<dotpath>" column. Repeatable. Avoids engine-specific JSON SQL.',
      (v, p: string[]) => (p || []).concat(v),
      [],
    )
    .action(async (opts: QueryOpts) => {
      const ctx = getCtx();
      ensureStarterRuntime(ctx);
      if (opts.sql && !opts.query) opts.query = opts.sql;
      if (opts.sql && opts.query && opts.sql !== opts.query) {
        throw new Error('Invalid argument: pass either --query or --sql, not both with different values.');
      }
      const timeoutDefault = ctx.runtimeConfigStore.queryTimeoutMs() ?? RUNTIME_CONSTANTS.query.defaultTimeoutMs;
      const rawTimeout = opts.timeout ?? opts.timeoutMs;
      const timeoutMs = parseTimeoutMs(rawTimeout, timeoutDefault);
      const target = deriveQueryTarget(ctx, opts);
      const env = target.env;
      const policy = environmentPolicy(ctx, env);
      const allowDiscovery = Boolean(opts.allowDiscovery) || policy.allowDiscoveryByDefault;
      const progress = createProgress({
        enabled: !ctx.jsonMode && !ctx.verbose,
        noAnimations: ctx.noAnimations,
        noColor: ctx.noColor,
        verbose: ctx.verbose,
        plainUpdates: !ctx.jsonMode && process.stderr.isTTY,
      });
      if (opts.explain && !opts.query) {
        throw new Error('Invalid argument: --explain requires --query (raw SQL).');
      }
      const request: QueryExecutionRequest = {
        datasource: opts.datasource,
        optsEnv: opts.env,
        env,
        namespace: target.namespace,
        service: target.service,
        intent: opts.intent,
        reason: opts.reason,
        query: opts.query || '',
        params: opts.param || [],
        allowDiscovery,
        allowMutate: Boolean(opts.allowMutate),
        allowPartitionScan: Boolean(opts.allowPartitionScan),
        allowSchemaIntrospection: Boolean(opts.allowSchemaIntrospection),
        explain: Boolean(opts.explain),
        rowsObject: Boolean(opts.rowsObject),
        jsonExtract: opts.jsonExtract || [],
        proto: opts.proto,
        protoRoot: opts.protoRoot,
        allowFlush: Boolean(opts.allowFlush),
        requestJson: opts.requestJson,
        skipProtoValidate: Boolean(opts.skipProtoValidate),
        timeoutMs,
        tz: opts.tz,
      };
      const route = queryRoute(request);
      try {
        if (allowDiscovery && !ctx.jsonMode) {
          progress.update('discovery mode enabled, bypassing daemon');
        }
        progress.update(route === 'direct' ? 'running direct query mode' : 'attempting daemon query path');
        if (route === 'daemon') {
          const outcome = await runDaemonQuery({ request, ctx, opts, progress });
          if (outcome === 'handled') return;
        }
        await runDirectQuery({ request, ctx, opts, progress });
      } finally {
        progress.stop();
      }
    });
}
