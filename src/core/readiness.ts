import fs from 'node:fs';
import path from 'node:path';
import { normalizeNamespace, normalizeService, runDatasourceConnectors } from './app.js';
import type { AppContext } from './app.js';
import { DoctorStatus } from '../types/core.js';
import type { DatasourceProfile, DoctorCheckCode, RemediationAction } from '../types/core.js';
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
  nextActions: string[];
  nextActionDetails: RemediationAction[];
  target?: {
    datasource: string | null;
  };
}

const READINESS_ACTION_PRIORITIES = {
  datasourceSetup: 5,
  kbSetup: 10,
  init: 20,
  datasourceRepair: 30,
  credsRepair: 40,
  introspect: 42,
  verify: 45,
  connectorSetup: 50,
  connectorConnect: 60,
  masterKey: 70,
  daemonStart: 80,
} as const;

const DATASOURCE_ADD_COMMAND =
  'taproot datasource add --name <name> --kind mysql --env <env> --service <service> --host <host> --port 3306 --database <db> --credential-ref <name>';
const CREDS_SET_COMMAND = 'taproot creds set --ref <ref> --user <user> --password <password>';
const DOCTOR_VERIFY_COMMAND = 'taproot doctor --datasource <name>';
const GRPC_LIST_COMMAND = 'taproot grpc list --datasource <name>';

const SETUP_KIND_COMMANDS: Record<string, string> = {
  mysql: DATASOURCE_ADD_COMMAND,
  postgres:
    'taproot datasource add --name <name> --kind postgres --env <env> --service <service> --host <host> --port 5432 --database <db> --credential-ref <name>',
  redis:
    'taproot datasource add --name <name> --kind redis --env <env> --service <service> --host <host> --port 6379 --credential-ref <name>',
  grpc:
    'taproot datasource add --name <name> --kind grpc --env <env> --service <service> --host <host> --port <port> --credential-ref <name> --hint protoRoot=<dir>',
};

const AUTH_FREE_SETUP_KINDS = new Set(['grpc']);

function normalizeSetupKind(kind?: string): string {
  const normalized = str(kind).trim().toLowerCase();
  return SETUP_KIND_COMMANDS[normalized] ? normalized : 'mysql';
}

function dedupeAction(
  actions: Map<string, RemediationAction>,
  action: RemediationAction,
): void {
  const existing = actions.get(action.command);
  if (!existing) {
    actions.set(action.command, action);
    return;
  }
  existing.priority = Math.min(existing.priority, action.priority);
  for (const reason of action.reasons) {
    if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
  }
  for (const check of action.checks) {
    if (!existing.checks.includes(check)) existing.checks.push(check);
  }
  for (const code of action.codes) {
    if (!existing.codes.includes(code)) existing.codes.push(code);
  }
}

function actionForReadiness(input: {
  command: string;
  priority: number;
  reason: string;
  checks?: string[];
  codes?: DoctorCheckCode[];
}): RemediationAction {
  return {
    command: input.command,
    priority: input.priority,
    reasons: [input.reason],
    checks: input.checks || [],
    codes: input.codes || [],
  };
}

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
  for (const [ref, names] of refToDatasources) {
    const creds = await ctx.credentialStore.get(ref);
    if (!Object.keys(creds).length) dangling.push(`${ref} (${names.length} datasource(s))`);
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
    return {
      check: 'credentials',
      status: DoctorStatus.Ok,
      detail: 'not required by the configured datasource kinds',
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

function connectorSetupCommand(datasource: DatasourceProfile, checks: ReadinessCheck[]): string {
  const firstMissing = checks.find((check) => isMissingConnectorConfigCheck(check));
  const label = str(firstMissing?.check).toLowerCase();
  if (label.startsWith('openvpn')) {
    return `taproot connector setup --datasource ${datasource.name} --connector openvpn --connect-command '<command>' --status-command '<command>'`;
  }
  if (label.startsWith('teleport')) {
    return `taproot connector setup --datasource ${datasource.name} --connector teleport --login-command '<command>'`;
  }
  if (label.startsWith('kubectl-portforward')) {
    return `taproot connector setup --datasource ${datasource.name} --connector kubectl-portforward --status-command '<command>' --connect-command '<command>'`;
  }
  const connector = str(label.match(/^connector:([^ ]+)/)?.[1]).trim();
  const flags = "--status-command '<command>' --connect-command '<command>'";
  return connector
    ? `taproot connector setup --datasource ${datasource.name} --connector ${connector} ${flags}`
    : `taproot connector setup --datasource ${datasource.name} --connector <name> ${flags}`;
}

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

export function nextActionDetailsForReadiness(
  readiness: ReadinessState,
  input?: { datasource?: DatasourceProfile; target?: ReadinessTargetInput; checks?: ReadinessCheck[]; setupKind?: string },
): RemediationAction[] {
  const actions = new Map<string, RemediationAction>();
  const relevantChecks = input?.checks || [];
  const add = (action: RemediationAction) => dedupeAction(actions, action);
  switch (readiness) {
    case 'missing_kb':
      add(
        actionForReadiness({
          command: 'export TAPROOT_KB_DIR=<dir>',
          priority: READINESS_ACTION_PRIORITIES.kbSetup,
          reason: 'No KB is configured. The KB is optional and only powers env/service routing, so skip this and run `taproot datasource add` if you address datasources by name.',
          checks: ['kb_dir'],
        }),
      );
      break;
    case 'missing_config':
      add(
        actionForReadiness({
          command: 'taproot --json init',
          priority: READINESS_ACTION_PRIORITIES.init,
          reason: 'Runtime config is missing, so init needs to create the starter configuration first.',
          checks: ['config_file'],
        }),
      );
      break;
    case 'missing_datasource':
      if (input?.target?.env && input?.target?.service) {
        add(
          actionForReadiness({
            command: `taproot --json init datasource --env ${input.target.env}${input.target.namespace ? ` --namespace ${input.target.namespace}` : ''} --service ${input.target.service}`,
            priority: READINESS_ACTION_PRIORITIES.datasourceRepair,
            reason: 'The target datasource does not exist yet, so KB-backed datasource creation/repair is the next step.',
            checks: ['target_datasource'],
          }),
        );
        break;
      }
      add(
        actionForReadiness({
          command: SETUP_KIND_COMMANDS[normalizeSetupKind(input?.setupKind)],
          priority: READINESS_ACTION_PRIORITIES.datasourceRepair,
          reason: 'No datasource profile is available yet, so create one before querying. Swap --kind for postgres/redis/grpc as needed, and add --connector <name> when the endpoint sits behind VPN, Teleport, or a port-forward.',
          checks: ['datasources'],
        }),
      );
      break;
    case 'missing_creds':
      if (input?.datasource) {
        add(
          actionForReadiness({
            command: `taproot --json creds set --ref ${input.datasource.credentialRef} --user <user> --password <password>`,
            priority: READINESS_ACTION_PRIORITIES.credsRepair,
            reason: 'The target datasource has no stored credentials yet, so credentials need to be added first.',
            checks: ['target_credentials'],
          }),
        );
        break;
      }
      add(
        actionForReadiness({
          command: CREDS_SET_COMMAND,
          priority: READINESS_ACTION_PRIORITIES.credsRepair,
          reason: 'No credentials are stored yet, so add the missing credential ref first.',
          checks: ['credentials'],
        }),
      );
      break;
    case 'missing_connector_config':
      if (input?.datasource) {
        const missingChecks = relevantChecks.filter((check) => isMissingConnectorConfigCheck(check));
        add(
          actionForReadiness({
            command: connectorSetupCommand(input.datasource, relevantChecks),
            priority: READINESS_ACTION_PRIORITIES.connectorSetup,
            reason: 'Connector wiring is incomplete, so connector setup must happen before the datasource can be used.',
            checks: missingChecks.map((check) => check.check),
            codes: missingChecks.map((check) => check.code).filter(Boolean) as DoctorCheckCode[],
          }),
        );
        break;
      }
      add(
        actionForReadiness({
          command: "taproot connector setup --datasource <name> --connector <name> --status-command '<command>' --connect-command '<command>'",
          priority: READINESS_ACTION_PRIORITIES.connectorSetup,
          reason: 'A required connector is not fully configured yet.',
        }),
      );
      break;
    case 'blocked_connector_auth':
      if (input?.datasource) {
        const blockedChecks = relevantChecks.filter((check) => !isMissingConnectorConfigCheck(check) && check.status !== DoctorStatus.Ok);
        add(
          actionForReadiness({
            command: `taproot doctor --datasource ${input.datasource.name} --connect`,
            priority: READINESS_ACTION_PRIORITIES.connectorConnect,
            reason: 'Connector auth/status is blocked, so rerunning the connector connect flow is the best next step.',
            checks: blockedChecks.map((check) => check.check),
            codes: blockedChecks.map((check) => check.code).filter(Boolean) as DoctorCheckCode[],
          }),
        );
        break;
      }
      add(
        actionForReadiness({
          command: 'taproot doctor --datasource <name> --connect',
          priority: READINESS_ACTION_PRIORITIES.connectorConnect,
          reason: 'Connector auth/status is blocked for this datasource.',
        }),
      );
      break;
    default:
      break;
  }
  return [...actions.values()].sort((a, b) => a.priority - b.priority || a.command.localeCompare(b.command));
}

export function nextActionsForReadiness(
  readiness: ReadinessState,
  input?: { datasource?: DatasourceProfile; target?: ReadinessTargetInput; checks?: ReadinessCheck[] },
): string[] {
  return nextActionDetailsForReadiness(readiness, input).map((action) => action.command);
}

function withSupplementalReadinessActions(
  actions: RemediationAction[],
  input: { checks: ReadinessCheck[]; setupKind?: string },
): RemediationAction[] {
  const merged = new Map<string, RemediationAction>();
  for (const action of actions) dedupeAction(merged, action);
  if (input.checks.find((check) => check.check === 'datasources')?.status !== DoctorStatus.Ok) {
    const kind = normalizeSetupKind(input.setupKind);
    dedupeAction(
      merged,
      actionForReadiness({
        command: SETUP_KIND_COMMANDS[kind],
        priority: READINESS_ACTION_PRIORITIES.datasourceSetup,
        reason: kind === 'grpc'
          ? 'No datasource exists yet, so this is the first setup step. protoRoot is a local directory of .proto sources, loaded recursively; add --connector <name> when the endpoint sits behind VPN, Teleport, or a port-forward.'
          : 'No datasource exists yet, so this is the first setup step. Re-run init with --kind to get the template for another engine, and add --connector <name> when the endpoint sits behind VPN, Teleport, or a port-forward.',
        checks: ['datasources'],
      }),
    );
    if (!AUTH_FREE_SETUP_KINDS.has(kind)) {
      dedupeAction(
        merged,
        actionForReadiness({
          command: CREDS_SET_COMMAND,
          priority: READINESS_ACTION_PRIORITIES.credsRepair,
          reason: 'Store the credentials under the same ref you passed to --credential-ref.',
          checks: ['credentials'],
        }),
      );
    }
    if (kind === 'grpc') {
      dedupeAction(
        merged,
        actionForReadiness({
          command: GRPC_LIST_COMMAND,
          priority: READINESS_ACTION_PRIORITIES.introspect,
          reason: 'Lists the services and methods found in the proto root. This runs offline, so it validates the proto setup before any network access.',
          checks: ['datasources'],
        }),
      );
    }
    dedupeAction(
      merged,
      actionForReadiness({
        command: DOCTOR_VERIFY_COMMAND,
        priority: READINESS_ACTION_PRIORITIES.verify,
        reason: 'Confirm the new datasource resolves and connects before running a query.',
        checks: ['datasources'],
      }),
    );
  }
  if (!process.env.TAPROOT_MASTER_KEY) {
    dedupeAction(
      merged,
      actionForReadiness({
        command: 'export TAPROOT_MASTER_KEY=<secret>',
        priority: READINESS_ACTION_PRIORITIES.masterKey,
        reason: 'A master key is not set, so TapRoot is using the fallback local credential encryption secret.',
        checks: ['master_key'],
      }),
    );
  }
  if (input.checks.find((check) => check.check === 'daemon')?.status !== DoctorStatus.Ok) {
    dedupeAction(
      merged,
      actionForReadiness({
        command: 'taproot --json daemon start',
        priority: READINESS_ACTION_PRIORITIES.daemonStart,
        reason: 'The daemon is not reachable, so start it before session-backed or daemon-assisted workflows.',
        checks: ['daemon'],
      }),
    );
  }
  return [...merged.values()].sort((a, b) => a.priority - b.priority || a.command.localeCompare(b.command));
}

export function nextCommandForReadiness(
  readiness: ReadinessState,
  input?: { datasource?: DatasourceProfile; target?: ReadinessTargetInput; checks?: ReadinessCheck[] },
): string | null {
  return nextActionDetailsForReadiness(readiness, input)[0]?.command || null;
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
  input?: { createdConfig?: boolean; target?: ReadinessTargetInput; setupKind?: string },
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
  const nextActionDetails = withSupplementalReadinessActions(
    normalizedTarget
      ? nextActionDetailsForReadiness(readiness, { datasource: targetDatasource, target: normalizedTarget, checks, setupKind: input?.setupKind })
      : nextActionDetailsForReadiness(readiness, { setupKind: input?.setupKind }),
    { checks, setupKind: input?.setupKind },
  );
  const nextActions = nextActionDetails.map((action) => action.command);

  return {
    checks,
    readiness,
    nextActions,
    nextActionDetails,
    ...(normalizedTarget ? { target: { datasource: targetDatasource?.name || null } } : {}),
  };
}
