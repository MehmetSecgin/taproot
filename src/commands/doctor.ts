import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { classifyError, defaultDatasourceName, normalizeNamespace, normalizeService, runDatasourceConnectors } from '../core/app.js';
import { bootstrapDatasource } from '../core/bootstrap.js';
import { criticalDatasourceKbConflicts, datasourceKbConflicts } from '../core/conflicts.js';
import { exitCodeForClass } from '../core/exit-codes.js';
import { renderTable, printJson, printJsonPluck } from '../core/output.js';
import { createProgress } from '../core/progress.js';
import { ensureStarterRuntime } from '../core/runtime-init.js';
import { DatasourceKind } from '../types/core.js';
import type { DatasourceProfile, DoctorCheck, DoctorCheckCode, DoctorNextAction } from '../types/core.js';

function compactDetail(detail: string, max = 160): string {
  const oneLine = detail.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}...`;
}

interface PrioritizedAction {
  action: string;
  priority: number;
  order: number;
  reasons: string[];
  checks: string[];
  codes: DoctorCheckCode[];
}

function upsertAction(
  store: Map<string, PrioritizedAction>,
  action: string,
  priority: number,
  orderRef: { current: number },
  metadata?: { reason?: string; check?: string; code?: DoctorCheckCode },
): void {
  const existing = store.get(action);
  if (existing) {
    if (priority < existing.priority) existing.priority = priority;
    if (metadata?.reason && !existing.reasons.includes(metadata.reason)) existing.reasons.push(metadata.reason);
    if (metadata?.check && !existing.checks.includes(metadata.check)) existing.checks.push(metadata.check);
    if (metadata?.code && !existing.codes.includes(metadata.code)) existing.codes.push(metadata.code);
    return;
  }
  store.set(action, {
    action,
    priority,
    order: orderRef.current++,
    reasons: metadata?.reason ? [metadata.reason] : [],
    checks: metadata?.check ? [metadata.check] : [],
    codes: metadata?.code ? [metadata.code] : [],
  });
}

const CONNECTOR_SETUP_HINTS: Record<string, (datasourceName: string) => string> = {
  openvpn: (name) =>
    `taproot connector setup --datasource ${name} --connector openvpn --connect-command '<command>' --status-command '<command>'`,
  teleport: (name) =>
    `taproot connector setup --datasource ${name} --connector teleport --login-command 'tsh login --proxy <proxy> --auth <auth>'`,
  'kubectl-portforward': (name) =>
    `taproot connector setup --datasource ${name} --connector kubectl-portforward --status-command '<command>' --connect-command '<command>'`,
};

function connectorSetupHint(datasourceName: string, connector: string): string {
  const builder = CONNECTOR_SETUP_HINTS[connector];
  if (builder) return builder(datasourceName);
  return `taproot connector setup --datasource ${datasourceName} --connector ${connector || '<name>'} ...`;
}

interface ConnectorActionStrategy {
  prefix: string;
  missingConfigRegex: RegExp;
  setupReason: string;
  reconnectReason: string;
}

const CONNECTOR_ACTION_STRATEGIES: ConnectorActionStrategy[] = [
  {
    prefix: 'openvpn',
    missingConfigRegex: /no connectcommand configured/i,
    setupReason: 'OpenVPN is missing required commands, so connector setup is the first repair.',
    reconnectReason: 'OpenVPN reported a blocked state, so retry the connector connect flow first.',
  },
  {
    prefix: 'teleport',
    missingConfigRegex: /no logincommand configured/i,
    setupReason: 'Teleport is missing login wiring, so connector setup is required first.',
    reconnectReason: 'Teleport reported a blocked session, so reconnect is the fastest next step.',
  },
  {
    prefix: 'kubectl-portforward',
    missingConfigRegex: /no connectcommand configured|no statuscommand configured/i,
    setupReason: 'kubectl port-forward wiring is incomplete, so setup is required before reconnecting.',
    reconnectReason: 'kubectl port-forward reported a blocked state, so retry the connector connect flow first.',
  },
];

const ACTION_PRIORITIES = {
  connectorSetup: 10,
  datasourceRepair: 20,
  connectorConnect: 30,
  credsShow: 40,
  credsSet: 50,
  datasourceShow: 60,
  timeoutRetry: 70,
} as const;

function connectorNameFromCheck(check: string): string {
  const label = String(check || '').toLowerCase();
  if (label.startsWith('openvpn')) return 'openvpn';
  if (label.startsWith('teleport')) return 'teleport';
  if (label.startsWith('kubectl-portforward')) return 'kubectl-portforward';
  return String(label.match(/^connector:([^ ]+)/)?.[1] || '').trim();
}

function isMissingConnectorConfigCode(code?: DoctorCheckCode): boolean {
  return (
    code === 'connector_plugin_missing' ||
    code === 'connector_mode_unsupported' ||
    code === 'connector_status_command_missing' ||
    code === 'connector_connect_command_missing' ||
    code === 'connector_disconnect_command_missing' ||
    code === 'connector_login_command_missing'
  );
}

function credentialRepairHint(datasource: DatasourceProfile): string {
  if (datasource.kind === DatasourceKind.TeleportMysql) {
    return `taproot --json creds set --ref ${datasource.credentialRef} --db-user <user> --password <password>`;
  }
  return `taproot --json creds set --ref ${datasource.credentialRef} --user <user> --password <password>`;
}

function datasourceRepairHint(datasource: DatasourceProfile): string {
  if (datasource.env && datasource.service) {
    return `taproot --json init datasource --env ${datasource.env}${datasource.namespace ? ` --namespace ${datasource.namespace}` : ''} --service ${datasource.service}`;
  }
  return `taproot datasource show --name ${datasource.name}`;
}

function addActionForCheck(
  actions: Map<string, PrioritizedAction>,
  command: string,
  priority: number,
  orderRef: { current: number },
  check: DoctorCheck,
  reason: string,
): void {
  upsertAction(actions, command, priority, orderRef, { reason, check: check.check, code: check.code });
}

function addExecutorNextActions(
  actions: Map<string, PrioritizedAction>,
  datasource: DatasourceProfile,
  check: DoctorCheck,
  orderRef: { current: number },
): boolean {
  const code = check.code;
  switch (code) {
    case 'executor_access_denied':
      addActionForCheck(
        actions,
        `taproot --json creds show --ref ${datasource.credentialRef}`,
        ACTION_PRIORITIES.credsShow,
        orderRef,
        check,
        'Executor rejected the stored datasource credentials.',
      );
      addActionForCheck(
        actions,
        credentialRepairHint(datasource),
        ACTION_PRIORITIES.credsSet,
        orderRef,
        check,
        'Executor access was denied, so the datasource credentials likely need repair.',
      );
      return true;
    case 'executor_auth_expired':
      if (datasource.connectors?.length) {
        addActionForCheck(
          actions,
          `taproot doctor --datasource ${datasource.name} --connect`,
          ACTION_PRIORITIES.connectorConnect,
          orderRef,
          check,
          'Connector-backed auth looks expired, so reconnect is the fastest recovery path.',
        );
      }
      addActionForCheck(
        actions,
        credentialRepairHint(datasource),
        ACTION_PRIORITIES.credsSet,
        orderRef,
        check,
        'Executor auth looks expired, so credentials may need to be refreshed.',
      );
      return true;
    case 'executor_connectivity':
      if (datasource.connectors?.length) {
        addActionForCheck(
          actions,
          `taproot doctor --datasource ${datasource.name} --connect`,
          ACTION_PRIORITIES.connectorConnect,
          orderRef,
          check,
          'A connector-backed connectivity failure is best retried through the connector connect flow first.',
        );
      }
      addActionForCheck(
        actions,
        `taproot datasource show --name ${datasource.name}`,
        ACTION_PRIORITIES.datasourceShow,
        orderRef,
        check,
        'Executor connectivity failed, so inspect the datasource target and connection settings.',
      );
      return true;
    case 'executor_unknown_target':
      addActionForCheck(
        actions,
        datasourceRepairHint(datasource),
        ACTION_PRIORITIES.datasourceRepair,
        orderRef,
        check,
        'The executor could not resolve the target, so the datasource routing needs repair.',
      );
      return true;
    case 'executor_configuration_missing':
      addActionForCheck(
        actions,
        datasourceRepairHint(datasource),
        ACTION_PRIORITIES.datasourceRepair,
        orderRef,
        check,
        'The datasource is missing required topology fields, so repair the datasource definition first.',
      );
      addActionForCheck(
        actions,
        credentialRepairHint(datasource),
        ACTION_PRIORITIES.credsSet,
        orderRef,
        check,
        'The executor is also missing required credential fields for this datasource.',
      );
      return true;
    case 'executor_query_timeout':
      addActionForCheck(
        actions,
        `taproot query --datasource ${datasource.name} --query '<sql>' --timeout-ms <ms>`,
        ACTION_PRIORITIES.timeoutRetry,
        orderRef,
        check,
        'The doctor query timed out, so retry with a narrower query or a larger timeout budget.',
      );
      return true;
    default:
      return false;
  }
}

function doctorNextActions(datasource: DatasourceProfile, checks: DoctorCheck[]): DoctorNextAction[] {
  const actions = new Map<string, PrioritizedAction>();
  const orderRef = { current: 0 };
  for (const check of checks) {
    const label = String(check.check || '').toLowerCase();
    const detail = String(check.detail || '');
    if (check.status === 'ok') continue;

    if (isMissingConnectorConfigCode(check.code)) {
      addActionForCheck(
        actions,
        connectorSetupHint(datasource.name, connectorNameFromCheck(check.check)),
        ACTION_PRIORITIES.connectorSetup,
        orderRef,
        check,
        'Connector wiring is incomplete, so setup is required before the datasource can be used.',
      );
      continue;
    }

    if (addExecutorNextActions(actions, datasource, check, orderRef)) {
      continue;
    }

    for (const strategy of CONNECTOR_ACTION_STRATEGIES) {
      if (!label.startsWith(strategy.prefix)) continue;
      if (strategy.missingConfigRegex.test(detail)) {
        addActionForCheck(
          actions,
          connectorSetupHint(datasource.name, strategy.prefix),
          ACTION_PRIORITIES.connectorSetup,
          orderRef,
          check,
          strategy.setupReason,
        );
      } else {
        addActionForCheck(
          actions,
          `taproot doctor --datasource ${datasource.name} --connect`,
          ACTION_PRIORITIES.connectorConnect,
          orderRef,
          check,
          strategy.reconnectReason,
        );
      }
    }
    if (/connect/i.test(label)) {
      addActionForCheck(
        actions,
        `taproot doctor --datasource ${datasource.name} --connect`,
        ACTION_PRIORITIES.connectorConnect,
        orderRef,
        check,
        'A connector connect check failed, so rerunning the connect flow is the best first step.',
      );
    }
  }
  return [...actions.values()]
    .sort((a, b) => (a.priority - b.priority) || (a.order - b.order))
    .map((entry) => ({
      command: entry.action,
      priority: entry.priority,
      reasons: entry.reasons,
      checks: entry.checks,
      codes: entry.codes,
    }));
}

function misconfiguredDatasourceNextActions(datasource: DatasourceProfile): DoctorNextAction[] {
  return [
    {
      command: `taproot --json init datasource --env ${datasource.env}${datasource.namespace ? ` --namespace ${datasource.namespace}` : ''} --service ${datasource.service}`,
      priority: ACTION_PRIORITIES.datasourceRepair,
      reasons: ['The datasource routing conflicts with KB-backed resolution and must be repaired before doctor can continue.'],
      checks: ['kb routing consistency'],
      codes: [],
    },
  ];
}

export function registerDoctor(program: Command, getCtx: () => AppContext): void {
  program
    .command('doctor')
    .description('Preflight checks against resolved datasource/plugin')
    .option('--datasource <name>')
    .option('--env <env>')
    .option('--namespace <namespace>')
    .option('--service <service>')
    .option('--connect', 'run connector connect steps during doctor', false)
    .option('--verbose-detail', 'print full check details in table mode', false)
    .option('--all', 'print all checks in table mode (default: warnings/failures only)', false)
    .option('--pluck <path>', 'return only the subtree at this dot-path of the JSON envelope')
    .action(async (opts) => {
      const ctx = getCtx();
      ensureStarterRuntime(ctx);
      const progress = createProgress({
        enabled: !ctx.jsonMode && !ctx.verbose,
        noAnimations: ctx.noAnimations,
        noColor: ctx.noColor,
        verbose: ctx.verbose,
        plainUpdates: !ctx.jsonMode && process.stderr.isTTY,
      });
      const logVerbose = (msg: string): void => {
        if (!ctx.jsonMode && ctx.verbose) process.stderr.write(`[taproot] ${msg}\n`);
      };

      try {
        progress.update('resolving datasource');
        let datasource = opts.datasource ? ctx.datasourceStore.get(opts.datasource) : undefined;
        const warnings: string[] = [];
        if (!datasource && opts.env && opts.service) {
          const service = normalizeService(opts.service, ctx.runtimeConfigStore.serviceAliases());
          const namespace = normalizeNamespace(opts.namespace);
          datasource = ctx.datasourceStore.resolveByEnvService(opts.env, service, namespace || undefined);
          if (!datasource) {
            const bootstrapped = await bootstrapDatasource(ctx, opts.env, service, defaultDatasourceName(opts.env, service, namespace || undefined), namespace || undefined);
            if (bootstrapped) {
              datasource = bootstrapped.profile;
              logVerbose(`bootstrapped datasource from KB (${bootstrapped.profile.name})`);
            }
          }
        }
        if (!datasource) {
          progress.fail('could not resolve datasource');
          throw new Error('Could not resolve datasource. Use --datasource or --env+--service.');
        }
        progress.update(`checking plugin for ${datasource.name}`);
        const plugin = ctx.pluginRegistry.get(datasource.kind);
        if (!plugin || !plugin.doctor) {
          progress.fail('doctor capability unavailable');
          throw new Error(`No doctor-capable plugin for datasource kind '${datasource.kind}'.`);
        }
        if (datasource.env && datasource.service) {
          const kb = ctx.kbStore.resolveConnection(datasource.service, datasource.env, datasource.namespace);
          if (kb) {
            const critical = criticalDatasourceKbConflicts(datasource, kb);
            if (critical.length) {
              const checks: DoctorCheck[] = [
                {
                  check: 'kb routing consistency',
                  status: 'fail' as const,
                  detail: `MISCONFIGURED_DATASOURCE: ${critical.join('; ')}`,
                },
              ];
              checks.push({
                check: 'doctor blocked',
                status: 'warn',
                detail: 'plugin/connectivity checks skipped until datasource routing matches KB',
              });
              const nextActionDetails = misconfiguredDatasourceNextActions(datasource);
              if (ctx.jsonMode) {
                printJsonPluck({
                  datasource: datasource.name,
                  plugin: plugin.manifest.name,
                  warnings,
                  checks,
                  nextActionDetails,
                  summary: { ok: 0, warn: 1, fail: 1, total: checks.length },
                }, opts.pluck ? String(opts.pluck) : undefined);
              } else {
                console.log(renderTable(checks.map((c) => ({ check: c.check, status: c.status, detail: c.detail }))));
                console.log('Next actions:');
                console.log(`- taproot --json init datasource --env ${datasource.env}${datasource.namespace ? ` --namespace ${datasource.namespace}` : ''} --service ${datasource.service}`);
              }
              process.exitCode = exitCodeForClass('MISCONFIGURED_DATASOURCE');
              return;
            }
            const conflicts = datasourceKbConflicts(datasource, kb);
            if (conflicts.length) warnings.push(`datasource overrides KB (${conflicts.join('; ')})`);
          }
        }
        const creds = await ctx.credentialStore.get(datasource.credentialRef);
        progress.update('running connector checks');
        const connectorChecks = await runDatasourceConnectors({
          datasource,
          credentialStore: ctx.credentialStore,
          pluginRegistry: ctx.pluginRegistry,
          mode: 'doctor',
        });
        const checks = [...connectorChecks];
        if (opts.connect) {
          progress.update('running connector connect step');
          checks.push(
            ...(await runDatasourceConnectors({
              datasource,
              credentialStore: ctx.credentialStore,
              pluginRegistry: ctx.pluginRegistry,
              mode: 'connect',
            })),
          );
        }
        progress.update(`running plugin doctor (${plugin.manifest.name})`);
        checks.push(...(await plugin.doctor({ datasource, credentials: creds })));

        const failCount = checks.filter((c) => c.status === 'fail').length;
        const warnCount = checks.filter((c) => c.status === 'warn').length;
        const okCount = checks.filter((c) => c.status === 'ok').length;
        const tableRows = checks.map((c) => ({
          check: c.check,
          status: c.status,
          detail: opts.verboseDetail || ctx.verbose ? c.detail : compactDetail(c.detail),
        }));
        const visibleRows = opts.all || ctx.verbose ? tableRows : tableRows.filter((r) => r.status !== 'ok');
        const nextActionDetails = doctorNextActions(datasource, checks);

        if (ctx.jsonMode) {
          printJsonPluck({
            datasource: datasource.name,
            plugin: plugin.manifest.name,
            warnings,
            checks,
            nextActionDetails,
            summary: { ok: okCount, warn: warnCount, fail: failCount, total: checks.length },
          }, opts.pluck ? String(opts.pluck) : undefined);
        } else {
          if (warnings.length) progress.warn(`warnings: ${warnings.join(' | ')}`);
          const summary = `doctor summary: ok=${okCount} warn=${warnCount} fail=${failCount} total=${checks.length}`;
          if (ctx.verbose) {
            console.log(summary);
          } else if (!failCount && !warnCount) {
            progress.succeed(summary);
          } else {
            progress.warn(summary);
          }
          if (visibleRows.length) {
            console.log(renderTable(visibleRows));
          } else if (opts.all || ctx.verbose) {
            console.log('No checks to display.');
          }
          if (nextActionDetails.length) {
            console.log('Next actions:');
            for (const action of nextActionDetails) console.log(`- ${action.command}`);
          }
        }

        if (checks.some((c) => c.status === 'fail')) {
          const firstFailure = checks.find((c) => c.status === 'fail');
          const code = classifyError(firstFailure?.detail || '');
          process.exitCode = exitCodeForClass(code);
        }
      } finally {
        progress.stop();
      }
    });
}
