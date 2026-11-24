import { grpcPlugin } from './grpc/index.js';
import { kubectlPortforwardPlugin } from './kubectl-portforward/index.js';
import { mysqlPlugin } from './mysql/index.js';
import { redisPlugin } from './redis/index.js';
import { teleportPlugin } from './teleport/index.js';
import { teleportMysqlPlugin } from './teleport-mysql/index.js';
import type { TapRootPlugin } from '../types/plugin.js';

export function builtinPlugins(): TapRootPlugin[] {
  return [mysqlPlugin, redisPlugin, grpcPlugin, teleportMysqlPlugin, teleportPlugin, kubectlPortforwardPlugin];
}
