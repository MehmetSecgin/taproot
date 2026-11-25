import type { Command } from 'commander';
import { isRecord } from '../core/json-shapes.js';
import type { LocalExecutor } from '../cli/types.js';
import type { AppContext } from '../core/app.js';
import { badInput } from '../core/taproot-error.js';
import { normalizeNamespace, normalizeService } from '../core/naming.js';
import { importRelations } from './kb-relations-import.js';
import { printSuccess } from '../core/output.js';
import { emptyToUndefined, firstNonEmpty, textUnlessFalsy } from '../core/text-presence.js';

type KbRecord = Record<string, unknown>;
type KbResolveOptions = { datasource?: string; service?: string; env?: string; namespace?: string };
type KbTablesOptions = { service: string; env?: string; text?: string; match?: string; list: boolean };
type KbTarget = { service: string; env: string; namespace?: string };

const MAX_LISTED_SERVICES = 10;
const ACTIVE_STATUS = 'active';

function kbServiceRecords(ctx: AppContext): KbRecord[] {
  const services: unknown[] = ctx.kbStore.services();
  return services.filter((service) => isRecord(service));
}

function kbTableRecords(ctx: AppContext): KbRecord[] {
  const tables: unknown[] = ctx.kbStore.tables();
  return tables.filter((table) => isRecord(table));
}

function tableNames(record: KbRecord): string[] {
  const names: unknown = record.tables;
  return Array.isArray(names) ? names.filter((name) => typeof name === 'string') : [];
}

function availableEnvironments(registeredService: KbRecord): string[] {
  const connections: unknown = registeredService.connections;
  const activeConnections = (Array.isArray(connections) ? connections : [])
    .filter((connection) => isRecord(connection))
    .filter((connection) => (textUnlessFalsy(connection.status) || ACTIVE_STATUS) === ACTIVE_STATUS);
  const labels = activeConnections.map((connection) => {
    const namespace = textUnlessFalsy(connection.namespace);
    return `${String(connection.env)}${namespace === '' ? '' : `/${namespace}`}`;
  });
  return [...new Set(labels)].toSorted();
}

function noKbConnectionError(ctx: AppContext, target: KbTarget): Error {
  const { service, env, namespace } = target;
  const registeredService = kbServiceRecords(ctx).find((record) => textUnlessFalsy(record.service).trim().toLowerCase() === service.toLowerCase());
  if (!registeredService) {
    const known = ctx.kbStore.listServices();
    const hiddenCount = known.length - MAX_LISTED_SERVICES;
    return new Error(`No KB connection match: service '${service}' is not registered in KB. Known services: ${known.slice(0, MAX_LISTED_SERVICES).join(', ')}${hiddenCount > 0 ? ` (+${hiddenCount})` : ''}`);
  }
  const namespaceHint = namespace === undefined ? '' : ` namespace=${namespace}`;
  const available = availableEnvironments(registeredService).join(', ') || '(none active)';
  return new Error(
    `No KB connection match: service '${service}' is registered but not for env=${env}${namespaceHint}. Available: ${available}. Register this env with 'taproot datasource add --env ${env} --service ${service} ...' or pick an available env.`,
  );
}

function requestedKbTarget(ctx: AppContext, opts: KbResolveOptions): KbTarget {
  const datasourceName = emptyToUndefined(opts.datasource);
  const profile = datasourceName === undefined ? undefined : ctx.datasourceStore.get(datasourceName);
  if (datasourceName !== undefined && !profile) {
    throw badInput(`Datasource not found: ${datasourceName}. List profiles with taproot datasource list.`);
  }
  const env = textUnlessFalsy(firstNonEmpty(opts.env, profile?.env)).trim();
  const requestedService = textUnlessFalsy(firstNonEmpty(opts.service, profile?.service)).trim();
  if (env === '' || requestedService === '') {
    throw badInput(datasourceName === undefined ? 'Specify --datasource <name>, or --env <env> and --service <service>.' : `Datasource ${datasourceName} has no env or service; pass --env and --service.`);
  }
  return {
    service: normalizeService(requestedService, ctx.runtimeConfigStore.serviceAliases()),
    env,
    namespace: emptyToUndefined(normalizeNamespace(firstNonEmpty(opts.namespace, profile?.namespace))),
  };
}

function resolveKbConnection(ctx: AppContext, opts: KbResolveOptions): KbRecord {
  const target = requestedKbTarget(ctx, opts);
  const connection = ctx.kbStore.resolveConnection(target.service, target.env, target.namespace);
  if (!connection) {
    throw noKbConnectionError(ctx, target);
  }
  return { service: target.service, ...connection };
}

function withTables(record: KbRecord, tables: unknown): KbRecord {
  return { ...record, tables };
}

function kbTables(ctx: AppContext, opts: KbTablesOptions): unknown {
  const service = normalizeService(opts.service, ctx.runtimeConfigStore.serviceAliases());
  const matchText = textUnlessFalsy(firstNonEmpty(opts.match, opts.text)).trim();
  const envFilter = emptyToUndefined(opts.env);
  const serviceRecords = kbTableRecords(ctx).filter((record) => textUnlessFalsy(record.service).toLowerCase() === service.toLowerCase());
  const inEnv = serviceRecords.filter((record) => envFilter === undefined || String(record.env) === envFilter);
  const filtered = inEnv.map((record) => withTables(
    record,
    matchText === '' ? record.tables : tableNames(record).filter((table) => table.toLowerCase().includes(matchText.toLowerCase())),
  ));
  return opts.list
    ? filtered.flatMap((record) => tableNames(record).map((table) => ({ service: record.service, env: record.env, database: record.database, table })))
    : filtered;
}

export function kbCommand(program: Command, executor: LocalExecutor): void {
  const kb = program.command('kb').description('Knowledge base resolvers');
  kb.hook('preAction', () => {
    executor.context().kbStore.requirePresent();
  });

  kb.command('resolve')
    .description('Resolve the KB connection (target, database, db_user, engine, access_method) for a service in an env')
    .option('--datasource <name>', 'take env, namespace and service from this datasource profile')
    .option('--service <service>', 'service name')
    .option('--env <env>', 'environment (e.g. qa, stg)')
    .option('--namespace <namespace>', 'namespace within the environment (e.g. develop)')
    .action((opts: KbResolveOptions) => {
      printSuccess(resolveKbConnection(executor.context(), opts));
    });

  kb.command('tables')
    .description('Tables the KB records for a service')
    .requiredOption('--service <service>', 'service name')
    .option('--env <env>', 'environment; omit for every environment')
    .option('--text <text>', 'substring filter on table names (alias: --match)')
    .option('--match <text>', 'substring filter on table names (alias of --text)')
    .option('--list', 'render flat list of matching table names instead of per-database counts', false)
    .action((opts: KbTablesOptions) => {
      printSuccess(kbTables(executor.context(), opts));
    });

  const relations = kb.command('relations').description('Curated cross-service relation operations');

  relations.command('list')
    .description('List all curated relations in the KB')
    .option('--cross-service', 'only relations that cross a service boundary', false)
    .action((opts: { crossService: boolean }) => {
      const allRelations = executor.context().kbStore.typedRelations();
      printSuccess(opts.crossService ? allRelations.filter((relation) => relation.from.service.toLowerCase() !== relation.to.service.toLowerCase()) : allRelations);
    });

  relations.command('import')
    .description('Merge a JSON file of curated relations into KB relations.json (dedup by id)')
    .requiredOption('--file <path>', 'path to a JSON array of relation objects')
    .action((opts: { file: string }) => {
      importRelations(executor.context(), opts.file);
    });

  kb.command('list-services')
    .description('List the services the KB knows')
    .action(() => {
      printSuccess(executor.context().kbStore.listServices());
    });
}
