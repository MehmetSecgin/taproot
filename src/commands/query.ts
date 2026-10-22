import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { environmentPolicy } from '../core/app.js';
import { RUNTIME_CONSTANTS } from '../core/constants.js';
import { badInput } from '../core/error-classification.js';
import { deriveQueryTarget } from '../core/execute-query.js';
import type { QueryExecutionRequest } from '../core/execute-query.js';
import { parseTimeoutMs } from '../core/query-timeout.js';
import { ensureStarterRuntime } from '../core/runtime-init.js';
import { runDaemonQuery } from './query-daemon.js';
import { runDirectQuery, verboseLog } from './query-direct.js';
import { queryRoute } from './query-route.js';
import type { QueryOpts } from './query-types.js';

export function registerQuery(program: Command, getCtx: () => AppContext): void {
  program
    .command('query')
    .description('Run a SQL query, Redis command or gRPC call against a datasource. Example: taproot query --datasource <name> --sql "SHOW TABLES"')
    .allowExcessArguments()
    .option('--datasource <name>', 'datasource profile name; find one with taproot datasource list <pattern>')
    .option('--env <env>', 'environment (e.g. qa, stg); pair with --service when no --datasource is given')
    .option('--namespace <namespace>', 'namespace within the environment (e.g. develop)')
    .option('--service <service>', 'service name; pair with --env')
    .option('--sql <native>', 'native query text: SQL, Redis command, or gRPC Service/Method')
    .option('--query <native>', 'same as --sql; reads better for a Redis command or a gRPC Service/Method')
    .option('--param <key=value>', 'repeatable', (v, p: string[]) => (p || []).concat(v), [])
    .option('--allow-discovery', 'fall back to probing kubectl/teleport targets when no profile or KB entry resolves the env+service. Off by default for reproducibility.', false)
    .option('--allow-mutate', 'allow mutating query', false)
    .option('--allow-partition-scan', 'allow querying RANGE/LIST partitioned tables without partition predicates', false)
    .option('--explain', 'wrap query with EXPLAIN; reports the plan instead of running the query', false)
    .option('--rows-object', 'emit rows as objects keyed by column name (legacy). Default JSON output uses compact array form paired with the columns array.', false)
    .option('--proto <Message>', 'decode binary reply payloads as the given protobuf message (e.g. OrderProto). Used by the redis plugin; requires --proto-root or a datasource-level default in resolverHints.protoRoot.')
    .option('--proto-root <dir>', 'directory containing .proto sources used for decoding. Loaded recursively. Defaults to resolverHints.protoRoot on the datasource if set.')
    .option('--allow-flush', 'permit Redis FLUSH-tier commands (FLUSHDB/FLUSHALL/SWAPDB/MIGRATE). Required in addition to --allow-mutate. Off by default.', false)
    .option('--request-json <json>', 'gRPC plugin: request message body as JSON. Overrides --param-built payloads. Example: \'{"values":[1,2,3]}\'. For a client-streaming or bidi method, pass an array with one element per message.')
    .option('--skip-proto-validate', 'gRPC plugin: bypass local proto schema validation of the request payload. Off by default; only use for deliberately malformed payloads (e.g. fuzzing).', false)
    .option(
      '--timeout <ms>',
      `abort queries that run longer than this (default ${RUNTIME_CONSTANTS.query.defaultTimeoutMs}; overridable via defaults.query.timeoutMs in runtime config)`,
    )
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
    .action(async (opts: QueryOpts, command: Command) => {
      if (command.args.length > 0) {
        throw badInput(
          `'query' takes no positional arguments (got ${command.args.length}). Pass the query text with --sql "<query>" and the datasource with --datasource <name>, e.g. taproot query --datasource demo-db --sql "SELECT 1".`,
        );
      }
      const ctx = getCtx();
      ensureStarterRuntime(ctx);
      const timeoutDefault = ctx.runtimeConfigStore.queryTimeoutMs() ?? RUNTIME_CONSTANTS.query.defaultTimeoutMs;
      const timeoutMs = parseTimeoutMs(opts.timeout, timeoutDefault);
      const target = deriveQueryTarget(ctx, opts);
      const env = target.env;
      const policy = environmentPolicy(ctx, env);
      const allowDiscovery = Boolean(opts.allowDiscovery) || policy.allowDiscoveryByDefault;
      if (opts.sql && opts.query) {
        throw badInput('pass the query text once, with --sql or --query, not both.');
      }
      const text = opts.sql || opts.query || '';
      if (opts.explain && !text) {
        throw badInput('--explain requires --sql.');
      }
      const request: QueryExecutionRequest = {
        datasource: opts.datasource,
        optsEnv: opts.env,
        env,
        namespace: target.namespace,
        service: target.service,
        query: text,
        params: opts.param || [],
        allowDiscovery,
        allowMutate: Boolean(opts.allowMutate),
        allowPartitionScan: Boolean(opts.allowPartitionScan),
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
      verboseLog(ctx)(route === 'direct' ? 'running direct query mode' : 'attempting daemon query path');
      if (route === 'daemon' && (await runDaemonQuery(request, ctx)) === 'handled') return;
      await runDirectQuery(request, ctx);
    });
}
