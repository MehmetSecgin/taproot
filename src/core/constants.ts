export const RUNTIME_CONSTANTS = {
  protocolVersion: 1,
  fingerprintVersion: 'fpv1',
  session: {
    idleTtlMs: 45 * 60 * 1000,
    hardTtlMs: 6 * 60 * 60 * 1000,
    maxRevalidateAttempts: 3,
    revalidateBackoffMs: [2000, 5000, 15000] as const,
    leaseHeartbeatIntervalMs: 5000,
    leaseStaleThresholdMs: 20000,
  },
  sweeper: {
    tickMs: 15 * 1000,
  },
  rpc: {
    requestTimeoutMs: 30 * 1000,
  },
} as const;
