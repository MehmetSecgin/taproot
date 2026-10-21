function intFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name] || '');
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.floor(raw);
}

export const RUNTIME_CONSTANTS = {
  protocolVersion: 1,
  fingerprintVersion: 'fpv1',
  session: {
    idleTtlMs: 45 * 60 * 1000,
    hardTtlMs: 6 * 60 * 60 * 1000,
    maxConcurrentLeases: intFromEnv('TAPROOT_MAX_CONCURRENT_LEASES', 4),
    maxRevalidateAttempts: 3,
    revalidateBackoffMs: [2000, 5000, 15000] as const,
    leaseHeartbeatIntervalMs: 5000,
    leaseStaleThresholdMs: 20000,
  },
  daemon: {
    maxConcurrentQueries: intFromEnv('TAPROOT_MAX_CONCURRENT_QUERIES', 6),
    maxQueuedQueries: intFromEnv('TAPROOT_MAX_QUEUED_QUERIES', 24),
  },
  sweeper: {
    tickMs: 15 * 1000,
  },
  rpc: {
    requestTimeoutMs: 30 * 1000,
  },
  query: {
    defaultTimeoutMs: intFromEnv('TAPROOT_QUERY_TIMEOUT_MS', 15 * 1000),
    maxRangeDays: intFromEnv('TAPROOT_MAX_RANGE_DAYS', 90),
    catalogTtlHours: intFromEnv('TAPROOT_CATALOG_TTL_HOURS', 24),
    catalogTimeoutMs: intFromEnv('TAPROOT_CATALOG_TIMEOUT_MS', 20 * 1000),
    repeatFailureWindowMs: 60 * 1000,
  },
  connector: {
    preflightTimeoutMs: intFromEnv('TAPROOT_CONNECTOR_PREFLIGHT_MS', 15 * 1000),
    statusCheckTimeoutMs: intFromEnv('TAPROOT_CONNECTOR_STATUS_MS', 3 * 1000),
    connectCheckTimeoutMs: intFromEnv('TAPROOT_CONNECTOR_CONNECT_MS', 12 * 1000),
  },
  plugin: {
    dbConnectTimeoutMs: 5_000,
    openvpnStatusTimeoutMs: 1_500,
    openvpnCommandTimeoutMs: 3_000,
  },
  runs: {
    ttlHours: 168,
    pruneIntervalMs: 24 * 60 * 60 * 1000,
    storedRowLimit: 1000,
  },
  grpc: {
    streamMessageLimit: intFromEnv('TAPROOT_GRPC_STREAM_MESSAGE_LIMIT', 1000),
    streamFailureRowLimit: 100,
  },
  defaultPorts: {
    mysql: 3306,
    postgres: 5432,
    redis: 6379,
    grpc: 6565,
  },
} as const;
