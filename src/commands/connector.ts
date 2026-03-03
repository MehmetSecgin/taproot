import { Command } from 'commander';
import type { AppContext, AppContext as Ctx } from '../core/app.js';
import { runDatasourceConnectors } from '../core/app.js';
import { printJson, renderRecord, renderTable } from '../core/output.js';

function compactDetail(detail: string, max = 160): string {
  const oneLine = detail.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}...`;
}

function summarizeTeleportStatus(detail: string): string {
  const text = detail.replace(/^\>\s*/gm, '').trim();
  const line = (label: string): string => {
    const m = text.match(new RegExp(`${label}:\\s*(.+)`, 'i'));
    return m?.[1]?.trim() || '';
  };
  const rolesRaw = line('Roles');
  const roles = rolesRaw ? rolesRaw.split(',').map((r) => r.trim()).filter(Boolean) : [];
  const rolesPreview = roles.length ? roles.slice(0, 6).join(', ') : '';
  const rolesSuffix = roles.length > 6 ? `, ... (+${roles.length - 6} more)` : '';
  const parts = [
    line('Logged in as') ? `user=${line('Logged in as')}` : '',
    line('Cluster') ? `cluster=${line('Cluster')}` : '',
    line('Databases') ? `databases=${line('Databases')}` : '',
    line('Valid until') ? `validUntil=${line('Valid until')}` : '',
    roles.length ? `roles=${roles.length}${rolesPreview ? ` (${rolesPreview}${rolesSuffix})` : ''}` : '',
  ].filter(Boolean);
  return parts.join(' | ') || compactDetail(detail, 200);
}

function formatDetail(check: string, detail: string, full: boolean): string {
  if (!full) return compactDetail(detail);
  if (check.toLowerCase().startsWith('teleport status')) return summarizeTeleportStatus(detail);
  return detail;
}

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
    .option('--all', 'print all checks in table mode (default: warnings/failures only)', false)
    .option('--verbose-detail', 'print full check details in table mode', false)
    .action(async (opts) => {
      const ctx = getCtx();
      const datasource = resolveDatasource(ctx, opts.datasource);
      const allChecks = await runDatasourceConnectors({
        datasource: datasource as any,
        credentialStore: ctx.credentialStore,
        pluginRegistry: ctx.pluginRegistry,
        mode: 'doctor',
      });
      const checks = opts.connector ? allChecks.filter((x) => x.check.toLowerCase().startsWith(String(opts.connector).toLowerCase())) : allChecks;
      const summary = {
        ok: checks.filter((x) => x.status === 'ok').length,
        warn: checks.filter((x) => x.status === 'warn').length,
        fail: checks.filter((x) => x.status === 'fail').length,
        total: checks.length,
      };
      if (ctx.jsonMode) {
        printJson({
          ok: true,
          data: { datasource: datasource.name, checks, summary },
        });
      } else {
        console.log(`connector summary: ok=${summary.ok} warn=${summary.warn} fail=${summary.fail} total=${summary.total}`);
        const rows = checks.map((x) => ({
          check: x.check,
          status: x.status,
          detail: formatDetail(x.check, x.detail, Boolean(opts.verboseDetail)),
        }));
        const showAll = opts.all || ctx.verbose || opts.verboseDetail;
        const visible = showAll ? rows : rows.filter((r) => r.status !== 'ok');
        if (visible.length) {
          console.log(renderTable(visible));
        } else {
          const healthy = checks.map((x) => x.check.replace(/\s+status$/i, ''));
          console.log(`All connectors healthy: ${healthy.join(', ')}`);
          console.log('Use --all to print full connector checks.');
        }
      }
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
      if (!connector) throw new Error('Connector name is required.');
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
      ctx.datasourceStore.save(profile as any);

      const out = {
        saved: true,
        datasource: datasource.name,
        connector,
        ref,
        keys: Object.keys(merged),
      };
      if (ctx.jsonMode) printJson({ ok: true, data: out });
      else {
        console.log(renderRecord(out));
      }
    });
}
