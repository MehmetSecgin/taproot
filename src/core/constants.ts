const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND;
const MS_PER_HOUR = MINUTES_PER_HOUR * MS_PER_MINUTE;

const SESSION_IDLE_TTL_MINUTES = 45;
const SESSION_HARD_TTL_HOURS = 6;
const DEFAULT_MAX_CONCURRENT_QUERIES = 6;
const DEFAULT_MAX_QUEUED_QUERIES = 24;
const DEFAULT_DAEMON_IDLE_EXIT_MINUTES = 30;
const SWEEPER_TICK_SECONDS = 15;
const RPC_REQUEST_TIMEOUT_SECONDS = 30;
const DEFAULT_QUERY_TIMEOUT_SECONDS = 15;
const DEFAULT_MAX_RANGE_DAYS = 90;
const DEFAULT_CATALOG_TTL_HOURS = HOURS_PER_DAY;
const DEFAULT_CATALOG_TIMEOUT_SECONDS = 20;
const CATALOG_FAILURE_RETRY_MINUTES = 5;
const CATALOG_MAX_AGE_AFTER_SCHEMA_ERROR_SECONDS = 60;
const CONNECTOR_PREFLIGHT_TIMEOUT_SECONDS = 15;
const CONNECTOR_STATUS_TIMEOUT_SECONDS = 3;
const CONNECTOR_CONNECT_TIMEOUT_SECONDS = 12;
const CONNECTOR_REUSE_SECONDS = 30;
const DEFAULT_GRPC_STREAM_MESSAGE_LIMIT = 1000;

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? '');
  if (!Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }
  return Math.floor(raw);
}

export const RUNTIME_CONSTANTS = {
  protocolVersion: 1,
  session: {
    idleTtlMs: SESSION_IDLE_TTL_MINUTES * MS_PER_MINUTE,
    hardTtlMs: SESSION_HARD_TTL_HOURS * MS_PER_HOUR,
    leaseHeartbeatIntervalMs: 5000,
    leaseStaleThresholdMs: 20_000,
  },
  daemon: {
    maxConcurrentQueries: positiveIntFromEnv('TAPROOT_MAX_CONCURRENT_QUERIES', DEFAULT_MAX_CONCURRENT_QUERIES),
    maxQueuedQueries: positiveIntFromEnv('TAPROOT_MAX_QUEUED_QUERIES', DEFAULT_MAX_QUEUED_QUERIES),
    idleExitMs: positiveIntFromEnv('TAPROOT_DAEMON_IDLE_EXIT_MS', DEFAULT_DAEMON_IDLE_EXIT_MINUTES * MS_PER_MINUTE),
  },
  sweeper: {
    tickMs: SWEEPER_TICK_SECONDS * MS_PER_SECOND,
  },
  rpc: {
    requestTimeoutMs: RPC_REQUEST_TIMEOUT_SECONDS * MS_PER_SECOND,
    queryReplyMarginMs: MS_PER_SECOND,
  },
  query: {
    defaultTimeoutMs: positiveIntFromEnv('TAPROOT_QUERY_TIMEOUT_MS', DEFAULT_QUERY_TIMEOUT_SECONDS * MS_PER_SECOND),
    maxRangeDays: positiveIntFromEnv('TAPROOT_MAX_RANGE_DAYS', DEFAULT_MAX_RANGE_DAYS),
    catalogTtlHours: positiveIntFromEnv('TAPROOT_CATALOG_TTL_HOURS', DEFAULT_CATALOG_TTL_HOURS),
    catalogTimeoutMs: positiveIntFromEnv('TAPROOT_CATALOG_TIMEOUT_MS', DEFAULT_CATALOG_TIMEOUT_SECONDS * MS_PER_SECOND),
    catalogFailureRetryMs: CATALOG_FAILURE_RETRY_MINUTES * MS_PER_MINUTE,
    catalogMaxAgeAfterSchemaErrorMs: CATALOG_MAX_AGE_AFTER_SCHEMA_ERROR_SECONDS * MS_PER_SECOND,
  },
  connector: {
    preflightTimeoutMs: positiveIntFromEnv('TAPROOT_CONNECTOR_PREFLIGHT_MS', CONNECTOR_PREFLIGHT_TIMEOUT_SECONDS * MS_PER_SECOND),
    statusCheckTimeoutMs: positiveIntFromEnv('TAPROOT_CONNECTOR_STATUS_MS', CONNECTOR_STATUS_TIMEOUT_SECONDS * MS_PER_SECOND),
    connectCheckTimeoutMs: positiveIntFromEnv('TAPROOT_CONNECTOR_CONNECT_MS', CONNECTOR_CONNECT_TIMEOUT_SECONDS * MS_PER_SECOND),
    connectReuseMs: positiveIntFromEnv('TAPROOT_CONNECTOR_REUSE_MS', CONNECTOR_REUSE_SECONDS * MS_PER_SECOND),
  },
  plugin: {
    dbConnectTimeoutMs: 5000,
  },
  grpc: {
    streamMessageLimit: positiveIntFromEnv('TAPROOT_GRPC_STREAM_MESSAGE_LIMIT', DEFAULT_GRPC_STREAM_MESSAGE_LIMIT),
    streamFailureRowLimit: 100,
  },
  defaultPorts: {
    mysql: 3306,
    redis: 6379,
    grpc: 6565,
  },
} as const;
