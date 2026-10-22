import fs from 'node:fs';
import path from 'node:path';
import { normalizeNamespace, normalizeService, runDatasourceConnectors } from './app.js';
import type { AppContext } from './app.js';
import { DoctorStatus } from '../types/core.js';
import type { DatasourceProfile, DoctorCheckCode } from '../types/core.js';
import { defaultSocketPath, rpcCall } from '../daemon/client.js';
import { RpcMethod } from '../daemon/types.js';
import { str } from './strings.js';

export type ReadinessState =
  | 'ready'
  | 'missing_kb'
  | 'missing_config'
  | 'missing_datasource'
  | 'missing_creds'
  | 'missing_connector_config'
  | 'blocked_connector_auth';
export type ReadinessCheckStatus = DoctorStatus;

export interface ReadinessTargetInput {
  datasource?: string;
  env?: string;
  namespace?: string;
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
  target?: {
    datasource: string | null;
  };
}

const AUTH_OPTIONAL_KINDS = new Set(['redis']);

function configCheck(ctx: AppContext, createdConfig: boolean): ReadinessCheck {
  const exists = fs.existsSync(ctx.paths.runtimeConfigFile);
  const detail = createdConfig ? `${ctx.paths.runtimeConfigFile} (created)` : ctx.paths.runtimeConfigFile;
  return {
    check: 'config_file',
    status: exists ? DoctorStatus.Ok : DoctorStatus.Fail,
    detail,
  };
}

function kbCheck(ctx: AppContext): ReadinessCheck {
  const kbDirExists = fs.existsSync(ctx.paths.kbDir);
  const servicesFile = path.join(ctx.paths.kbDir, 'services.json');
  const servicesExists = fs.existsSync(servicesFile);
  if (kbDirExists && servicesExists) {
    return { check: 'kb_dir', status: DoctorStatus.Ok, detail: `${ctx.paths.kbDir} (services.json found)` };
  }
  if (kbDirExists) {
    return { check: 'kb_dir', status: DoctorStatus.Warn, detail: `${ctx.paths.kbDir} (services.json missing)` };
  }
  return {
    check: 'kb_dir',
    status: DoctorStatus.Warn,
    detail: `${ctx.paths.kbDir} (not set up; optional, only needed for KB-backed env/service routing)`,
  };
}

async function daemonCheck(ctx: AppContext): Promise<ReadinessCheck> {
  try {
    const socketPath = defaultSocketPath(ctx.paths.stateRoot);
    const res = await rpcCall({ method: RpcMethod.DaemonStatus, socketPath, timeoutMs: 1000 });
    if (!res.ok) throw new Error(res.error?.message || 'daemon unavailable');
    return { check: 'daemon', status: DoctorStatus.Ok, detail: `reachable via ${socketPath}` };
  } catch (error) {
    return {
      check: 'daemon',
      status: DoctorStatus.Warn,
      detail: (error as Error)?.message || 'daemon unavailable',
    };
  }
}

const AUTH_REQUIRED_KINDS = new Set(['mysql', 'postgres', 'teleport-mysql', 'teleport-postgres']);

async function credentialRefsCheck(ctx: AppContext): Promise<ReadinessCheck> {
  const refToDatasources = new Map<string, string[]>();
  for (const d of ctx.datasourceStore.list()) {
    if (!AUTH_REQUIRED_KINDS.has(d.kind)) continue;
    const ref = str(d.credentialRef).trim();
    if (!ref) continue;
    if (!refToDatasources.has(ref)) refToDatasources.set(ref, []);
    refToDatasources.get(ref)!.push(d.name);
  }
  const dangling: string[] = [];
  try {
    for (const [ref, names] of refToDatasources) {
      const creds = await ctx.credentialStore.get(ref);
      if (!Object.keys(creds).length) dangling.push(`${ref} (${names.length} datasource(s))`);
    }
  } catch (error) {
    return { check: 'credential_refs', status: DoctorStatus.Fail, detail: str((error as Error).message) };
  }
  return {
    check: 'credential_refs',
    status: dangling.length ? DoctorStatus.Warn : DoctorStatus.Ok,
    detail: dangling.length
      ? `referenced but not set: ${dangling.join('; ')} — set with \`taproot creds set --ref <ref>\``
      : 'all referenced credential refs resolve',
  };
}

function credentialsCheck(ctx: AppContext): ReadinessCheck {
  const file = ctx.paths.credentialFile;
  if (fs.existsSync(file)) return { check: 'credentials', status: DoctorStatus.Ok, detail: file };
  const datasources = ctx.datasourceStore.list();
  if (datasources.length && !datasources.some((d) => AUTH_REQUIRED_KINDS.has(d.kind))) {
    const optionalKinds = [...new Set(datasources.filter((d) => AUTH_OPTIONAL_KINDS.has(d.kind)).map((d) => d.kind))];
    return {
      check: 'credentials',
      status: DoctorStatus.Ok,
      detail: optionalKinds.length
        ? `optional for the configured datasource kinds (${optionalKinds.join(', ')}); set credentials only when the server has AUTH enabled`
        : 'not required by the configured datasource kinds',
    };
  }
  return {
    check: 'credentials',
    status: DoctorStatus.Warn,
    detail: `${file} (created on first \`taproot creds set\`)`,
  };
}

export function computeReadiness(checks: ReadinessCheck[]): ReadinessState {
  const byName = new Map(checks.map((check) => [check.check, check]));
  if ((byName.get('kb_dir')?.status || DoctorStatus.Ok) !== DoctorStatus.Ok) return 'missing_kb';
  if ((byName.get('config_file')?.status || DoctorStatus.Ok) !== DoctorStatus.Ok) return 'missing_config';
  if ((byName.get('datasources')?.status || DoctorStatus.Ok) !== DoctorStatus.Ok) return 'missing_datasource';
  if ((byName.get('credentials')?.status || DoctorStatus.Ok) !== DoctorStatus.Ok) return 'missing_creds';
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

function isMissingConnectorConfigCheck(check: ReadinessCheck): boolean {
  if (check.code) return MISSING_CONNECTOR_CONFIG_CODES.has(check.code);
  const label = str(check.check).toLowerCase();
  const detail = str(check.detail).toLowerCase();
  return /connector plugin not found/.test(detail) || /mode 'doctor' not supported/.test(detail) || /no (status|connect|disconnect|login)command configured/.test(detail) || (label.startsWith('connector:') && check.status !== DoctorStatus.Ok);
}

function targetReadiness(
  baseChecks: ReadinessCheck[],
  targetDatasource: DatasourceProfile | undefined,
  targetCredentialPresent: boolean,
  connectorChecks: ReadinessCheck[],
): ReadinessState {
  const byName = new Map(baseChecks.map((check) => [check.check, check]));
  if ((byName.get('kb_dir')?.status || DoctorStatus.Ok) !== DoctorStatus.Ok) return 'missing_kb';
  if ((byName.get('config_file')?.status || DoctorStatus.Ok) !== DoctorStatus.Ok) return 'missing_config';
  if (!targetDatasource) return 'missing_datasource';
  if (!targetCredentialPresent) return 'missing_creds';
  if (connectorChecks.some((check) => isMissingConnectorConfigCheck(check))) return 'missing_connector_config';
  if (connectorChecks.some((check) => check.status !== DoctorStatus.Ok)) return 'blocked_connector_auth';
  return 'ready';
}

async function resolveTargetDatasource(ctx: AppContext, target: ReadinessTargetInput): Promise<DatasourceProfile | undefined> {
  if (target.datasource) return ctx.datasourceStore.get(String(target.datasource).trim());
  const env = str(target.env).trim();
  const namespace = normalizeNamespace(str(target.namespace).trim());
  const service = normalizeService(str(target.service).trim(), ctx.runtimeConfigStore.serviceAliases());
  if (!env || !service) return undefined;
  return ctx.datasourceStore.resolveByEnvService(env, service, namespace || undefined);
}

export async function collectReadinessSnapshot(
  ctx: AppContext,
  input?: { createdConfig?: boolean; target?: ReadinessTargetInput },
): Promise<ReadinessSnapshot> {
  const pluginNames = ctx.pluginRegistry.list().map((plugin) => plugin.manifest.name);
  const datasources = ctx.datasourceStore.list();
  const checks: ReadinessCheck[] = [
    { check: 'node_version', status: DoctorStatus.Ok, detail: process.version },
    { check: 'state_root', status: fs.existsSync(ctx.paths.stateRoot) ? DoctorStatus.Ok : DoctorStatus.Fail, detail: ctx.paths.stateRoot },
    kbCheck(ctx),
    { check: 'plugins', status: DoctorStatus.Ok, detail: `${pluginNames.length} loaded: ${pluginNames.join(', ')}` },
    {
      check: 'master_key',
      status: process.env.TAPROOT_MASTER_KEY ? DoctorStatus.Ok : DoctorStatus.Warn,
      detail: process.env.TAPROOT_MASTER_KEY ? 'TAPROOT_MASTER_KEY is set' : 'TAPROOT_MASTER_KEY is unset; credential storage falls back to a derived local secret',
    },
    configCheck(ctx, Boolean(input?.createdConfig)),
    {
      check: 'datasources',
      status: datasources.length > 0 ? DoctorStatus.Ok : DoctorStatus.Warn,
      detail: datasources.length > 0
        ? `${datasources.length} datasource profile(s)`
        : 'none yet; add one with `taproot datasource add`',
    },
    credentialsCheck(ctx),
    await credentialRefsCheck(ctx),
    await daemonCheck(ctx),
  ];

  const target = input?.target;
  const normalizedTarget = target
    ? {
        datasource: str(target.datasource).trim() || undefined,
        env: str(target.env).trim() || undefined,
        namespace: normalizeNamespace(str(target.namespace).trim()) || undefined,
        service: normalizeService(str(target.service).trim(), ctx.runtimeConfigStore.serviceAliases()) || undefined,
      }
    : undefined;

  let targetDatasource: DatasourceProfile | undefined;
  let targetCredentialPresent = false;
  let connectorChecks: ReadinessCheck[] = [];
    if (normalizedTarget && (normalizedTarget.datasource || (normalizedTarget.env && normalizedTarget.service))) {
    targetDatasource = await resolveTargetDatasource(ctx, normalizedTarget);
    checks.push({
      check: 'target_datasource',
      status: targetDatasource ? DoctorStatus.Ok : DoctorStatus.Fail,
      detail: targetDatasource
        ? targetDatasource.name
        : normalizedTarget.datasource
          ? `Datasource not found: ${normalizedTarget.datasource}`
          : `No datasource profile found for env=${normalizedTarget.env}${normalizedTarget.namespace ? ` namespace=${normalizedTarget.namespace}` : ''} service=${normalizedTarget.service}`,
    });
    if (targetDatasource) {
      const creds = await ctx.credentialStore.get(targetDatasource.credentialRef);
      targetCredentialPresent = Object.keys(creds).length > 0;
      checks.push({
        check: 'target_credentials',
        status: targetCredentialPresent ? DoctorStatus.Ok : DoctorStatus.Fail,
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
  return {
    checks,
    readiness,
    ...(normalizedTarget ? { target: { datasource: targetDatasource?.name || null } } : {}),
  };
}
