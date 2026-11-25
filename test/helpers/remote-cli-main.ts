import { buildCli } from '../../src/cli/build-cli.js';
import { remoteExecutor } from '../../src/cli/remote-executor.js';
import { datasourceListCommand } from '../../src/commands/datasource-list.js';
import { queryCommand } from '../../src/commands/query.js';
import { schemaCommand } from '../../src/commands/schema.js';

const env = (name: string): string => process.env[name] ?? '';

const daemonHost = env('TEST_DAEMON_HOST');
const daemonPort = Number(env('TEST_DAEMON_PORT'));
const tlsFiles = { caFile: env('TEST_TLS_CA'), certFile: env('TEST_TLS_CERT'), keyFile: env('TEST_TLS_KEY') };

void buildCli({
  name: 'remote',
  description: 'Reads datasources through a daemon over mutual TLS.',
  commands: [datasourceListCommand, schemaCommand, queryCommand],
  executor: remoteExecutor({ host: daemonHost, port: daemonPort, tls: tlsFiles }),
}).run(process.argv);
