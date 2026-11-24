import type { TapRootPlugin } from '../../types/plugin.js';
import { closeAllMysqlPools, closeMysqlSessionPools } from '../_shared/mysql-connection-lease.js';
import { checkTeleportMysql } from './doctor.js';
import { executeTeleportMysql } from './execute.js';
import { closeAllTeleportMysqlProxies, closeTeleportMysqlSessionProxies } from './proxy-pool.js';

export const teleportMysqlPlugin: TapRootPlugin = {
  manifest: {
    name: 'teleport-mysql',
    capabilities: ['doctor', 'executeRead'],
  },

  doctor: checkTeleportMysql,

  execute: executeTeleportMysql,

  async closeSession(sessionId) {
    await closeTeleportMysqlSessionProxies(sessionId);
    await closeMysqlSessionPools(sessionId);
  },

  async close() {
    await closeAllTeleportMysqlProxies();
    await closeAllMysqlPools();
  },
};
