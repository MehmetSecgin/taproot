import { Command } from 'commander';
import type { AppContext, AppContext as Ctx } from '../core/app.js';
import { runDatasourceConnectors } from '../core/app.js';
import { badInput } from '../core/error-classification.js';
import { printJson, respondOk } from '../core/output.js';
import { DoctorStatus } from '../types/core.js';

function connectorRefKey(name: string): string {
  return `${name}CredentialRef`;
}

function defaultConnectorRef(datasource: { name: string; env?: string; service?: string }, connector: string): string {
  if (datasource.env && datasource.service) return `${connector}:${datasource.env}:${datasource.service}`;
  return `${connector}:${datasource.name}`;
}

function resolveDatasource(ctx: Ctx, datasourceName: string) {
  const datasource = ctx.datasourceStore.get(datasourceName);
  if (!datasource) throw new Error(`Datasource not found: ${datasourceName}`);
  return datasource;
}

export function registerConnector(program: Command, getCtx: () => AppContext): void {
  const c = program.command('connector').description('Connector setup and status operations');

  c.command('status')
    .requiredOption('--datasource <name>')
    .option('--connector <name>')
    .action(async (opts) => {
      const ctx = getCtx();
      const datasource = resolveDatasource(ctx, opts.datasource);
      const allChecks = await runDatasourceConnectors({
        datasource,
        credentialStore: ctx.credentialStore,
        pluginRegistry: ctx.pluginRegistry,
        mode: 'doctor',
      });
      const checks = opts.connector ? allChecks.filter((x) => x.check.toLowerCase().startsWith(String(opts.connector).toLowerCase())) : allChecks;
      const summary = {
        ok: checks.filter((x) => x.status === DoctorStatus.Ok).length,
        warn: checks.filter((x) => x.status === DoctorStatus.Warn).length,
        fail: checks.filter((x) => x.status === DoctorStatus.Fail).length,
        total: checks.length,
      };
      printJson({
        ok: true,
        data: { datasource: datasource.name, checks, summary },
      });
    });

  c.command('setup')
    .requiredOption('--datasource <name>')
    .requiredOption('--connector <name>')
    .option('--ref <ref>')
    .option('--status-command <cmd>')
    .option('--connect-command <cmd>')
    .option('--disconnect-command <cmd>')
    .option('--login-command <cmd>')
    .action(async (opts) => {
      const ctx = getCtx();
      const datasource = resolveDatasource(ctx, opts.datasource);
      const connector = String(opts.connector).trim();
      if (!connector) throw badInput('Connector name is required.');
      if (!datasource.connectors?.includes(connector)) {
        throw new Error(`Connector '${connector}' is not configured on datasource '${datasource.name}'.`);
      }

      const refKey = connectorRefKey(connector);
      const ref = String(opts.ref || datasource.resolverHints?.[refKey] || defaultConnectorRef(datasource, connector));
      const values = await ctx.credentialStore.get(ref);
      const merged = {
        ...values,
        ...(opts.statusCommand ? { statusCommand: String(opts.statusCommand) } : {}),
        ...(opts.connectCommand ? { connectCommand: String(opts.connectCommand) } : {}),
        ...(opts.disconnectCommand ? { disconnectCommand: String(opts.disconnectCommand) } : {}),
        ...(opts.loginCommand ? { loginCommand: String(opts.loginCommand) } : {}),
      };

      await ctx.credentialStore.set(ref, merged);
      const profile = {
        ...datasource,
        resolverHints: {
          ...(datasource.resolverHints || {}),
          [refKey]: ref,
        },
      };
      ctx.datasourceStore.save(profile);

      const out = {
        saved: true,
        datasource: datasource.name,
        connector,
        ref,
        keys: Object.keys(merged),
      };
      respondOk(out);
    });
}
