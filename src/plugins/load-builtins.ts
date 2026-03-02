import { mysqlPlugin } from '../plugins-builtins/mysql/index.js';
import { postgresPlugin } from '../plugins-builtins/postgres/index.js';
import { openvpnPlugin } from '../plugins-builtins/openvpn/index.js';
import { teleportPlugin } from '../plugins-builtins/teleport/index.js';
import { teleportMysqlPlugin } from '../plugins-builtins/teleport-mysql/index.js';
import { kubectlPortforwardPlugin } from '../plugins-builtins/kubectl-portforward/index.js';
import { PluginRegistry } from './registry.js';

export function loadBuiltins(registry: PluginRegistry): void {
  registry.register(mysqlPlugin);
  registry.register(postgresPlugin);
  registry.register(openvpnPlugin);
  registry.register(kubectlPortforwardPlugin);
  registry.register(teleportPlugin);
  registry.register(teleportMysqlPlugin);
}
