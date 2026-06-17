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
    defaultTimeoutMs: intFromEnv('TAPROOT_QUERY_TIMEOUT_MS', 5 * 1000),
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
  defaultPorts: {
    mysql: 3306,
    postgres: 5432,
    redis: 6379,
    grpc: 6565,
  },
} as const;
