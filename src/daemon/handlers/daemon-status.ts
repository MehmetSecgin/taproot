import { RUNTIME_CONSTANTS } from '../../core/constants.js';
import { nowIso } from '../../core/time.js';
import { TAPROOT_VERSION } from '../../core/version.js';
import { DAEMON_VERSION_MISMATCH } from '../types.js';
import type { Handler } from './types.js';

export const handleDaemonStatus: Handler = async ({ base, deps }) => {
  base.ok = true;
  base.data = {
    version: TAPROOT_VERSION,
    pid: process.pid,
    startedAt: new Date(deps.startedAt).toISOString(),
    now: nowIso(),
    uptimeMs: Date.now() - deps.startedAt,
    socketPath: deps.socketPath,
    sessions: deps.sessions.list().length,
    queryLimiter: deps.queryLimiter.stats(),
    limits: {
      maxConcurrentQueries: RUNTIME_CONSTANTS.daemon.maxConcurrentQueries,
      maxQueuedQueries: RUNTIME_CONSTANTS.daemon.maxQueuedQueries,
      maxConcurrentLeases: RUNTIME_CONSTANTS.session.maxConcurrentLeases,
    },
  };
};

export const handleDaemonStop: Handler = async ({ base }) => {
  base.ok = true;
  base.data = { stopping: true };
  return { postWrite: 'stopSocket' };
};

export const handleVersionMismatch: Handler = async ({ req, base }) => {
  base.error = {
    code: DAEMON_VERSION_MISMATCH,
    message: `taprootd ${TAPROOT_VERSION} does not match the CLI ${req.clientVersion}; it stopped so the CLI can start a matching one.`,
  };
  return { postWrite: 'stopSocket' };
};
