import { grpcPlugin } from '../api/plugins/grpc.js';
import { kubectlPortforwardPlugin } from '../api/plugins/kubectl-portforward.js';
import { mysqlPlugin } from '../api/plugins/mysql.js';
import { redisPlugin } from '../api/plugins/redis.js';
import { teleportPlugin } from '../api/plugins/teleport.js';
import { teleportMysqlPlugin } from '../api/plugins/teleport-mysql.js';
import type { TapRootPlugin } from '../types/core.js';

export function builtinPlugins(): TapRootPlugin[] {
  return [mysqlPlugin, redisPlugin, grpcPlugin, teleportMysqlPlugin, teleportPlugin, kubectlPortforwardPlugin];
}
