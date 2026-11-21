import { RUNTIME_CONSTANTS } from '../../core/constants.js';
import { nowIso } from '../../core/time.js';
import { TAPROOT_VERSION } from '../../core/version.js';
import { DAEMON_VERSION_MISMATCH, RpcMethod } from '../types.js';
import type { DaemonMethod, Handler } from './types.js';

export function statusMethod(): DaemonMethod {
  return {
    name: RpcMethod.DaemonStatus,
    handle: async ({ base, deps }) => {
      base.ok = true;
      base.data = {
        version: TAPROOT_VERSION,
        pid: process.pid,
        startedAt: new Date(deps.startedAt).toISOString(),
        now: nowIso(),
        uptimeMs: Date.now() - deps.startedAt,
        ...deps.endpoint(),
        sessions: deps.sessions.list().length,
        queryLimiter: deps.queryLimiter.stats(),
        limits: {
          maxConcurrentQueries: RUNTIME_CONSTANTS.daemon.maxConcurrentQueries,
          maxQueuedQueries: RUNTIME_CONSTANTS.daemon.maxQueuedQueries,
        },
      };
    },
  };
}

export function stopMethod(): DaemonMethod {
  return {
    name: RpcMethod.DaemonStop,
    handle: async ({ base }) => {
      base.ok = true;
      base.data = { stopping: true };
      return { postWrite: 'stopSocket' };
    },
  };
}

export const stopForOtherVersion: Handler = async ({ req, base }) => {
  base.error = {
    code: DAEMON_VERSION_MISMATCH,
    message: `taprootd ${TAPROOT_VERSION} does not match the CLI ${req.clientVersion}; it stopped so the CLI can start a matching one.`,
  };
  return { postWrite: 'stopSocket' };
};

export const refuseOtherVersion: Handler = async ({ req, base }) => {
  base.error = {
    code: DAEMON_VERSION_MISMATCH,
    message: `this daemon runs ${TAPROOT_VERSION} and the client runs ${req.clientVersion}; run the same version on both sides.`,
  };
};
