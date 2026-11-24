import type { Command } from 'commander';
import type { LocalExecutor } from '../cli/types.js';
import { printSuccess } from '../core/output.js';
import { datasourceAddCommand } from './datasource-add.js';
import { importDatasources } from './datasource-bulk-import.js';
import type { DatasourceImportOptions } from './datasource-bulk-import.js';
import { datasourceGroup } from './datasource-group.js';
import { requireDatasource } from './datasource-lookup.js';
import { resolveDatasourceProfile } from './datasource-resolve.js';
import type { DatasourceResolveOptions } from './datasource-resolve.js';

export function datasourceAdminCommand(program: Command, executor: LocalExecutor): void {
  const datasourceCommands = datasourceGroup(program);

  datasourceCommands.command('show')
    .description('Print one datasource profile')
    .argument('<name>')
    .action((name: string) => {
      printSuccess(requireDatasource(executor.context(), name));
    });

  datasourceCommands.command('remove').description('Delete a datasource profile').argument('<name>').action((name: string) => {
    const wasRemoved = executor.context().datasourceStore.remove(name);
    if (!wasRemoved) {
      throw new Error(`Datasource not found: ${name}`);
    }
    printSuccess({ removed: true, name });
  });

  datasourceAddCommand(datasourceCommands, () => executor.context());

  datasourceCommands.command('resolve')
    .description('Find the datasource profile for an env and service')
    .requiredOption('--env <env>', 'environment (e.g. qa, stg)')
    .option('--namespace <namespace>', 'namespace within the environment (e.g. develop)')
    .requiredOption('--service <service>', 'service name')
    .action(async (opts: DatasourceResolveOptions) => {
      printSuccess(await resolveDatasourceProfile(executor.context(), opts));
    });

  datasourceCommands.command('import')
    .description('Bulk-add datasource profiles from a JSON file')
    .option('--file <path>', 'JSON array of profiles, or an object with a data/datasources array')
    .option('--credential-ref <ref>', 'credentialRef applied to imported profiles that lack one')
    .option('--dry-run', 'validate and report without saving', false)
    .action((opts: DatasourceImportOptions) => {
      importDatasources(executor.context(), opts);
    });
}
