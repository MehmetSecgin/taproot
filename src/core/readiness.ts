import fs from 'node:fs';
import path from 'node:path';
import { normalizeService, runDatasourceConnectors } from './app.js';
import type { AppContext } from './app.js';
import type { DatasourceProfile, DoctorCheckCode } from '../types/core.js';
import { defaultSocketPath, rpcCall } from '../daemon/client.js';

export type ReadinessState =
  | 'ready'
  | 'missing_kb'
  | 'missing_config'
  | 'missing_datasource'
  | 'missing_creds'
  | 'missing_connector_config'
  | 'blocked_connector_auth';
export type ReadinessCheckStatus = 'ok' | 'warn' | 'fail';

export interface ReadinessTargetInput {
  datasource?: string;
  env?: string;
  service?: string;
}

export interface ReadinessCheck {
  check: string;
  status: ReadinessCheckStatus;
  detail: string;
  code?: DoctorCheckCode;
}

export interface ReadinessSnapshot {
  checks: ReadinessCheck[];
  readiness: ReadinessState;
  nextActions: string[];
  target?: {
    datasource: string | null;
  };
}

function configCheck(ctx: AppContext, createdConfig: boolean): ReadinessCheck {
  const exists = fs.existsSync(ctx.paths.runtimeConfigFile);
  const detail = createdConfig ? `${ctx.paths.runtimeConfigFile} (created)` : ctx.paths.runtimeConfigFile;
  return {
    check: 'config_file',
    status: exists ? 'ok' : 'fail',
    detail,
  };
}

function kbCheck(ctx: AppContext): ReadinessCheck {
  const kbDirExists = fs.existsSync(ctx.paths.kbDir);
  const servicesFile = path.join(ctx.paths.kbDir, 'services.json');
  const servicesExists = fs.existsSync(servicesFile);
  if (kbDirExists && servicesExists) {
    return { check: 'kb_dir', status: 'ok', detail: `${ctx.paths.kbDir} (services.json found)` };
  }
  if (kbDirExists) {
    return { check: 'kb_dir', status: 'warn', detail: `${ctx.paths.kbDir} (services.json missing)` };
  }
  return { check: 'kb_dir', status: 'fail', detail: `${ctx.paths.kbDir} (directory missing)` };
}

async function daemonCheck(ctx: AppContext): Promise<ReadinessCheck> {
  try {
    const socketPath = defaultSocketPath(ctx.paths.stateRoot);
    const res = await rpcCall({ method: 'daemon.status', socketPath, timeoutMs: 1000 });
    if (!res.ok) throw new Error(res.error?.message || 'daemon unavailable');
    return { check: 'daemon', status: 'ok', detail: `reachable via ${socketPath}` };
  } catch (error) {
    return {
      check: 'daemon',
      status: 'warn',
      detail: (error as Error)?.message || 'daemon unavailable',
    };
  }
}

export function computeReadiness(checks: ReadinessCheck[]): ReadinessState {
  const byName = new Map(checks.map((check) => [check.check, check]));
  if ((byName.get('kb_dir')?.status || 'ok') !== 'ok') return 'missing_kb';
  if ((byName.get('config_file')?.status || 'ok') !== 'ok') return 'missing_config';
  if ((byName.get('datasources')?.status || 'ok') !== 'ok') return 'missing_datasource';
  if ((byName.get('credentials')?.status || 'ok') !== 'ok') return 'missing_creds';
  return 'ready';
}

const MISSING_CONNECTOR_CONFIG_CODES = new Set<DoctorCheckCode>([
  'connector_plugin_missing',
  'connector_mode_unsupported',
  'connector_status_command_missing',
  'connector_connect_command_missing',
  'connector_disconnect_command_missing',
  'connector_login_command_missing',
]);

function connectorSetupCommand(datasource: DatasourceProfile, checks: ReadinessCheck[]): string {
  const firstMissing = checks.find((check) => isMissingConnectorConfigCheck(check));
  const label = String(firstMissing?.check || '').toLowerCase();
  if (label.startsWith('openvpn')) {
    return `taproot connector setup --datasource ${datasource.name} --connector openvpn --connect-command '<command>' --status-command '<command>'`;
  }
  if (label.startsWith('teleport')) {
    return `taproot connector setup --datasource ${datasource.name} --connector teleport --login-command '<command>'`;
  }
  if (label.startsWith('kubectl-portforward')) {
    return `taproot connector setup --datasource ${datasource.name} --connector kubectl-portforward --status-command '<command>' --connect-command '<command>'`;
  }
  const connector = String(label.match(/^connector:([^ ]+)/)?.[1] || '').trim();
  return connector
    ? `taproot connector setup --datasource ${datasource.name} --connector ${connector} ...`
    : `taproot connector setup --datasource ${datasource.name} --connector <name> ...`;
}

function isMissingConnectorConfigCheck(check: ReadinessCheck): boolean {
  if (check.code) return MISSING_CONNECTOR_CONFIG_CODES.has(check.code);
  const label = String(check.check || '').toLowerCase();
  const detail = String(check.detail || '').toLowerCase();
  return /connector plugin not found/.test(detail) || /mode 'doctor' not supported/.test(detail) || /no (status|connect|disconnect|login)command configured/.test(detail) || (label.startsWith('connector:') && check.status !== 'ok');
}

function targetReadiness(
  baseChecks: ReadinessCheck[],
  targetDatasource: DatasourceProfile | undefined,
  targetCredentialPresent: boolean,
  connectorChecks: ReadinessCheck[],
): ReadinessState {
  const byName = new Map(baseChecks.map((check) => [check.check, check]));
  if ((byName.get('kb_dir')?.status || 'ok') !== 'ok') return 'missing_kb';
  if ((byName.get('config_file')?.status || 'ok') !== 'ok') return 'missing_config';
  if (!targetDatasource) return 'missing_datasource';
  if (!targetCredentialPresent) return 'missing_creds';
  if (connectorChecks.some((check) => isMissingConnectorConfigCheck(check))) return 'missing_connector_config';
  if (connectorChecks.some((check) => check.status !== 'ok')) return 'blocked_connector_auth';
  return 'ready';
}

export function nextActionsForReadiness(
  readiness: ReadinessState,
  input?: { datasource?: DatasourceProfile; target?: ReadinessTargetInput; checks?: ReadinessCheck[] },
): string[] {
  switch (readiness) {
    case 'missing_kb':
      return [
        'Set OBSIDIAN_MEMORY_ROOT to a memory root that contains domains/engineering/references/db-kb, then rerun: taproot --json init',
      ];
    case 'missing_config':
      return ['Run: taproot --json init'];
    case 'missing_datasource':
      if (input?.target?.env && input?.target?.service) {
        return [`Create the datasource with taproot --json init datasource --env ${input.target.env} --service ${input.target.service}`];
      }
      return ['Create a datasource with taproot --json init datasource --env <env> --service <service> or taproot --json datasource add ...'];
    case 'missing_creds':
      if (input?.datasource) {
        return [`Store credentials with taproot --json creds set --ref ${input.datasource.credentialRef} --user <user> --password <password>`];
      }
      return ['Store credentials with taproot --json creds set --ref <ref> --user <user> --password <password>'];
    case 'missing_connector_config':
      if (input?.datasource) return [connectorSetupCommand(input.datasource, input.checks || [])];
      return ['Configure datasource connectors with taproot connector setup --datasource <name> --connector <name> ...'];
    case 'blocked_connector_auth':
      if (input?.datasource) return [`Run: taproot doctor --datasource ${input.datasource.name} --connect`];
      return ['Run: taproot doctor --datasource <name> --connect'];
    default:
      return [];
  }
}

export function nextCommandForReadiness(
  readiness: ReadinessState,
  input?: { datasource?: DatasourceProfile; target?: ReadinessTargetInput; checks?: ReadinessCheck[] },
): string | null {
  switch (readiness) {
    case 'missing_kb':
      return 'taproot --json init';
    case 'missing_config':
      return 'taproot --json init';
    case 'missing_datasource':
      if (input?.target?.env && input?.target?.service) {
        return `taproot --json init datasource --env ${input.target.env} --service ${input.target.service}`;
      }
      if (input?.target?.datasource) return 'taproot --json datasource add ...';
      return 'taproot --json datasource add ...';
    case 'missing_creds':
      if (input?.datasource) {
        return `taproot --json creds set --ref ${input.datasource.credentialRef} --user <user> --password <password>`;
      }
      return 'taproot --json creds set --ref <ref> --user <user> --password <password>';
    case 'missing_connector_config':
      if (input?.datasource) {
        return connectorSetupCommand(input.datasource, input.checks || []);
      }
      return 'taproot connector setup --datasource <name> --connector <name> ...';
    case 'blocked_connector_auth':
      if (input?.datasource) return `taproot doctor --datasource ${input.datasource.name} --connect`;
      return 'taproot doctor --datasource <name> --connect';
    default:
      return null;
  }
}

async function resolveTargetDatasource(ctx: AppContext, target: ReadinessTargetInput): Promise<DatasourceProfile | undefined> {
  if (target.datasource) return ctx.datasourceStore.get(String(target.datasource).trim());
  const env = String(target.env || '').trim();
  const service = normalizeService(String(target.service || '').trim(), ctx.runtimeConfigStore.serviceAliases());
  if (!env || !service) return undefined;
  return ctx.datasourceStore.resolveByEnvService(env, service);
}

export async function collectReadinessSnapshot(
  ctx: AppContext,
  input?: { createdConfig?: boolean; target?: ReadinessTargetInput },
): Promise<ReadinessSnapshot> {
  const pluginNames = ctx.pluginRegistry.list().map((plugin) => plugin.manifest.name);
  const datasources = ctx.datasourceStore.list();
  const checks: ReadinessCheck[] = [
    { check: 'node_version', status: 'ok', detail: process.version },
    { check: 'state_root', status: fs.existsSync(ctx.paths.stateRoot) ? 'ok' : 'fail', detail: ctx.paths.stateRoot },
    kbCheck(ctx),
    { check: 'plugins', status: 'ok', detail: `${pluginNames.length} loaded: ${pluginNames.join(', ')}` },
    {
      check: 'master_key',
      status: process.env.TAPROOT_MASTER_KEY ? 'ok' : 'warn',
      detail: process.env.TAPROOT_MASTER_KEY ? 'TAPROOT_MASTER_KEY is set' : 'TAPROOT_MASTER_KEY is unset; credential storage falls back to a derived local secret',
    },
    configCheck(ctx, Boolean(input?.createdConfig)),
    {
      check: 'datasources',
      status: datasources.length > 0 ? 'ok' : 'fail',
      detail: `${datasources.length} datasource profile(s)`,
    },
    {
      check: 'credentials',
      status: fs.existsSync(ctx.paths.credentialFile) ? 'ok' : 'fail',
      detail: ctx.paths.credentialFile,
    },
    await daemonCheck(ctx),
  ];

  const target = input?.target;
  const normalizedTarget = target
    ? {
        datasource: String(target.datasource || '').trim() || undefined,
        env: String(target.env || '').trim() || undefined,
        service: normalizeService(String(target.service || '').trim(), ctx.runtimeConfigStore.serviceAliases()) || undefined,
      }
    : undefined;

  let targetDatasource: DatasourceProfile | undefined;
  let targetCredentialPresent = false;
  let connectorChecks: ReadinessCheck[] = [];
  if (normalizedTarget && (normalizedTarget.datasource || (normalizedTarget.env && normalizedTarget.service))) {
    targetDatasource = await resolveTargetDatasource(ctx, normalizedTarget);
    checks.push({
      check: 'target_datasource',
      status: targetDatasource ? 'ok' : 'fail',
      detail: targetDatasource
        ? targetDatasource.name
        : normalizedTarget.datasource
          ? `Datasource not found: ${normalizedTarget.datasource}`
          : `No datasource profile found for env=${normalizedTarget.env} service=${normalizedTarget.service}`,
    });
    if (targetDatasource) {
      const creds = await ctx.credentialStore.get(targetDatasource.credentialRef);
      targetCredentialPresent = Object.keys(creds).length > 0;
      checks.push({
        check: 'target_credentials',
        status: targetCredentialPresent ? 'ok' : 'fail',
        detail: targetCredentialPresent
          ? `${targetDatasource.credentialRef} is populated`
          : `${targetDatasource.credentialRef} has no stored values`,
      });
      if (targetCredentialPresent) {
        connectorChecks = await runDatasourceConnectors({
          datasource: targetDatasource,
          credentialStore: ctx.credentialStore,
          pluginRegistry: ctx.pluginRegistry,
          mode: 'doctor',
        });
        checks.push(...connectorChecks);
      }
    }
  }

  const readiness = normalizedTarget
    ? targetReadiness(checks, targetDatasource, targetCredentialPresent, connectorChecks)
    : computeReadiness(checks);
  const nextActions = normalizedTarget
    ? nextActionsForReadiness(readiness, { datasource: targetDatasource, target: normalizedTarget, checks })
    : nextActionsForReadiness(readiness);
  if (!process.env.TAPROOT_MASTER_KEY) {
    nextActions.push('Set TAPROOT_MASTER_KEY to avoid using the fallback credential encryption secret');
  }
  if (checks.find((check) => check.check === 'daemon')?.status !== 'ok') {
    nextActions.push('Start the daemon with: taproot --json daemon start');
  }

  return {
    checks,
    readiness,
    nextActions,
    ...(normalizedTarget ? { target: { datasource: targetDatasource?.name || null } } : {}),
  };
}
