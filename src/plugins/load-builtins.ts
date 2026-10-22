import { mysqlPlugin } from '../plugins-builtins/mysql/index.js';
import { redisPlugin } from '../plugins-builtins/redis/index.js';
import { grpcPlugin } from '../plugins-builtins/grpc/index.js';
import { teleportPlugin } from '../plugins-builtins/teleport/index.js';
import { teleportMysqlPlugin } from '../plugins-builtins/teleport-mysql/index.js';
import { kubectlPortforwardPlugin } from '../plugins-builtins/kubectl-portforward/index.js';
import { PluginRegistry } from './registry.js';

export function loadBuiltins(registry: PluginRegistry): void {
  registry.register(mysqlPlugin);
  registry.register(redisPlugin);
  registry.register(grpcPlugin);
  registry.register(kubectlPortforwardPlugin);
  registry.register(teleportPlugin);
  registry.register(teleportMysqlPlugin);
}
