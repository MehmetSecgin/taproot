import { buildCli } from '../../src/cli/build-cli.js';
import { remoteExecutor } from '../../src/cli/remote-executor.js';
import { datasourceListCommand } from '../../src/commands/datasource-list.js';
import { queryCommand } from '../../src/commands/query.js';
import { schemaCommand } from '../../src/commands/schema.js';

const env = (name: string): string => process.env[name] || '';

void buildCli({
  name: 'remote',
  description: 'Reads datasources through a daemon over mutual TLS.',
  commands: [datasourceListCommand, schemaCommand, queryCommand],
  executor: remoteExecutor({
    host: env('TEST_DAEMON_HOST'),
    port: Number(env('TEST_DAEMON_PORT')),
    tls: { caFile: env('TEST_TLS_CA'), certFile: env('TEST_TLS_CERT'), keyFile: env('TEST_TLS_KEY') },
  }),
}).run(process.argv);
