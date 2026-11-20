import { mysqlPlugin } from '../plugins-builtins/mysql/index.js';
import { redisPlugin } from '../plugins-builtins/redis/index.js';
import { kafkaPlugin } from '../plugins-builtins/kafka/index.js';
import { grpcPlugin } from '../plugins-builtins/grpc/index.js';
import { teleportPlugin } from '../plugins-builtins/teleport/index.js';
import { teleportMysqlPlugin } from '../plugins-builtins/teleport-mysql/index.js';
import { kubectlPortforwardPlugin } from '../plugins-builtins/kubectl-portforward/index.js';
import type { TapRootPlugin } from '../types/core.js';

export type PluginRegistry = Map<string, TapRootPlugin>;

export function builtinPlugins(): PluginRegistry {
  const plugins = [mysqlPlugin, redisPlugin, grpcPlugin, kafkaPlugin, teleportMysqlPlugin, teleportPlugin, kubectlPortforwardPlugin];
  return new Map(plugins.map((plugin) => [plugin.manifest.name, plugin]));
}
