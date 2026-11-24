import type { Command } from 'commander';
import { collectRepeated } from '../cli/options.js';
import type { AppContext } from '../core/app.js';
import { printSuccess } from '../core/output.js';
import { validatedProfileFromOptions } from './datasource-add-options.js';
import type { DatasourceAddOptions } from './datasource-add-options.js';
import { probeSavedProfile } from './datasource-probe.js';

async function addDatasource(ctx: AppContext, opts: DatasourceAddOptions): Promise<void> {
  const profile = validatedProfileFromOptions(ctx, opts);
  const existedBeforeSave = Boolean(ctx.datasourceStore.get(opts.name));
  const saved = ctx.datasourceStore.save(profile);
  if (!opts.probe) {
    printSuccess(saved);
    return;
  }
  const checks = await probeSavedProfile(ctx, saved, existedBeforeSave);
  printSuccess({ ...saved, probe: { ok: true, checks } });
}

export function datasourceAddCommand(datasourceGroup: Command, createContext: () => AppContext): void {
  datasourceGroup.command('add')
    .description('Save a datasource profile; re-running with the same --name replaces it')
    .requiredOption('--name <name>', 'profile name, by convention <env>-<service>[-<namespace>]')
    .requiredOption('--kind <kind>', 'mysql, teleport-mysql, redis or grpc')
    .option('--credential-ref <ref>', 'defaults to --env')
    .option('--env <env>', 'environment (e.g. qa, stg)')
    .option('--namespace <namespace>', 'namespace within the environment (e.g. develop)')
    .option('--service <service>', 'service name')
    .option('--host <host>', 'hostname')
    .option('--port <port>', 'port')
    .option('--database <db>', 'database name (redis: database number)')
    .option('--target <target>', 'Teleport database name (teleport-mysql)')
    .option('--ssl', 'connect over TLS (grpc: use TLS instead of plaintext h2c)', false)
    .option('--connector <name>', 'repeatable', collectRepeated, [])
    .option('--connector-ref <name=ref>', 'repeatable connector credential refs', collectRepeated, [])
    .option('--hint <key=value>', 'repeatable resolverHints key=value: protoRoot=<dir>[,<dir>] (grpc, redis), protoMessage=<Message> (redis), probeService=<pkg.Service> and metadata.<key>=<value> (grpc), timeZone=<offset|IANA name> (mysql), dbUser=<user> (teleport-mysql)', collectRepeated, [])
    .option('--teleport-ref <ref>', 'shorthand for --connector-ref teleport=<ref>')
    .option('--allow-read', 'allow read', true)
    .option('--allow-mutate', 'allow mutate', false)
    .option('--strict-keyspace', 'redis: refuse KEYS unless --allow-keys, and require SCAN to carry COUNT (max 200)', false)
    .option('--require-database', 'redis: refuse queries when --database is unset instead of falling back to database 0', false)
    .option('--probe', 'after save, run plugin doctor() against the new profile; the profile stays saved on failure', false)
    .action(async (opts: DatasourceAddOptions) => {
      await addDatasource(createContext(), opts);
    });
}
