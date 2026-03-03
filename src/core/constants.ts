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
} as const;
