import type { Command } from 'commander';
import { presentQueryReply } from '../cli/query-present.js';
import type { CliCommand, QueryOpts } from '../cli/types.js';
import { RUNTIME_CONSTANTS } from '../core/constants.js';
import { badInput } from '../core/error-classification.js';

const QUERY_OPTIONS = {
  datasource: (command, cli) => command.option('--datasource <name>', `datasource profile name; find one with ${cli} datasource list <pattern>`),
  env: (command) => command.option('--env <env>', 'environment (e.g. qa, stg); pair with --service when no --datasource is given'),
  namespace: (command) => command.option('--namespace <namespace>', 'namespace within the environment (e.g. develop)'),
  service: (command) => command.option('--service <service>', 'service name; pair with --env'),
  sql: (command) => command.option('--sql <native>', 'native query text: SQL, Redis command, or gRPC Service/Method'),
  query: (command) => command.option('--query <native>', 'same as --sql; reads better for a Redis command or a gRPC Service/Method'),
  param: (command) => command.option('--param <key=value>', 'repeatable', (v, p: string[]) => (p || []).concat(v), []),
  'allow-discovery': (command) => command.option('--allow-discovery', 'fall back to probing kubectl/teleport targets when no profile or KB entry resolves the env+service. Off by default for reproducibility. Needs the user\'s explicit go-ahead.', false),
  'allow-mutate': (command) => command.option('--allow-mutate', 'allow mutating query. Needs the user\'s explicit go-ahead.', false),
  'allow-partition-scan': (command) => command.option('--allow-partition-scan', 'allow querying RANGE/LIST partitioned tables without partition predicates. Needs the user\'s explicit go-ahead; add the partition column to WHERE instead.', false),
  explain: (command) => command.option('--explain', 'wrap query with EXPLAIN; reports the plan instead of running the query', false),
  'rows-object': (command) => command.option('--rows-object', 'emit rows as objects keyed by column name (legacy). Default JSON output uses compact array form paired with the columns array.', false),
  proto: (command) => command.option('--proto <Message>', 'decode binary reply payloads as the given protobuf message (e.g. OrderProto). Used by the redis plugin; requires --proto-root or a datasource-level default in resolverHints.protoRoot.'),
  'proto-root': (command) => command.option('--proto-root <dir>', 'directory containing .proto sources used for decoding. Loaded recursively. Defaults to resolverHints.protoRoot on the datasource if set.'),
  'allow-flush': (command) => command.option('--allow-flush', 'permit Redis FLUSH-tier commands (FLUSHDB/FLUSHALL/SWAPDB/MIGRATE). Required in addition to --allow-mutate. Off by default. Needs the user\'s explicit go-ahead.', false),
  'allow-keys': (command) => command.option('--allow-keys', 'permit Redis KEYS on a datasource added with --strict-keyspace. KEYS is O(N) and blocks the whole instance; use SCAN with COUNT instead. Off by default. Needs the user\'s explicit go-ahead.', false),
  'request-json': (command) => command.option('--request-json <json>', `gRPC plugin: request message body as JSON. Overrides --param-built payloads. Example: '{"values":[1,2,3]}'. For a client-streaming or bidi method, pass an array with one element per message, up to ${RUNTIME_CONSTANTS.grpc.streamMessageLimit} (TAPROOT_GRPC_STREAM_MESSAGE_LIMIT).`),
  'skip-proto-validate': (command) => command.option('--skip-proto-validate', 'gRPC plugin: bypass local proto schema validation of the request payload. Off by default; only use for deliberately malformed payloads (e.g. fuzzing).', false),
  timeout: (command) => command.option(
    '--timeout <ms>',
    `abort queries that run longer than this (default ${RUNTIME_CONSTANTS.query.defaultTimeoutMs}; set the default with TAPROOT_QUERY_TIMEOUT_MS or defaults.query.timeoutMs in runtime config)`,
  ),
  tz: (command) => command.option(
    '--tz <offset|name>',
    'session time zone for WHERE timestamp literals and rendered TIMESTAMP columns. Defaults to UTC (+00:00). Accepts an offset (e.g. +05:30) or IANA name (e.g. Europe/Berlin).',
  ),
  'json-extract': (command) => command.option(
    '--json-extract <column:dotpath>',
    'extract a value from a raw JSON column client-side after fetching, adding a derived "<column>.<dotpath>" column. Repeatable. Avoids engine-specific JSON SQL.',
    (v, p: string[]) => (p || []).concat(v),
    [],
  ),
} satisfies Record<string, (command: Command, cli: string) => Command>;

export type QueryFlag = keyof typeof QUERY_OPTIONS;

export const QUERY_FLAGS = Object.keys(QUERY_OPTIONS) as QueryFlag[];

function knownQueryFlags(flags: readonly string[]): readonly QueryFlag[] {
  const unknown = flags.filter((flag) => !(QUERY_FLAGS as readonly string[]).includes(flag));
  if (unknown.length) throw new Error(`unknown query flags: ${unknown.join(', ')}; known: ${QUERY_FLAGS.join(', ')}.`);
  return flags as readonly QueryFlag[];
}

export function queryCommandWith(options: { flags: readonly QueryFlag[] }): CliCommand {
  const offered = knownQueryFlags(options.flags);
  return (program, executor) => {
    const cli = program.name();
    const command = program
      .command('query')
      .description(`Run a SQL query, Redis command or gRPC call against a datasource. Example: ${cli} query --datasource <name> --sql "SHOW TABLES"`)
      .allowExcessArguments();
    for (const flag of offered) QUERY_OPTIONS[flag](command, cli);
    command.action(async (opts: QueryOpts, invoked: Command) => {
      if (invoked.args.length > 0) {
        throw badInput(
          `'query' takes no positional arguments (got ${invoked.args.length}). Pass the query text with --sql "<query>" and the datasource with --datasource <name>, e.g. ${cli} query --datasource demo-db --sql "SELECT 1".`,
        );
      }
      presentQueryReply(await executor.query(opts));
    });
  };
}

export const queryCommand = queryCommandWith({ flags: QUERY_FLAGS });
