import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from './app.js';
import { DoctorStatus } from '../types/plugin.js';
import type { DatasourceProfile } from '../types/datasource.js';
import type { DoctorCheck } from '../types/plugin.js';
import { rpcCall } from '../daemon/client.js';
import { defaultSocketPath } from '../daemon/socket-path.js';
import { RpcMethod } from '../daemon/types.js';
import { nonEmptyOr, textUnlessFalsy } from './text-presence.js';

type ReadinessState = 'ready' | 'missing_kb' | 'missing_config' | 'missing_datasource' | 'missing_creds';

type ReadinessSnapshot = {
  checks: DoctorCheck[];
  readiness: ReadinessState;
};

const AUTH_OPTIONAL_KINDS = new Set(['redis']);
const AUTH_REQUIRED_KINDS = new Set(['mysql', 'teleport-mysql']);
const DAEMON_PROBE_TIMEOUT_MS = 1000;

const READINESS_BLOCKERS: { checkName: string; state: ReadinessState }[] = [
  { checkName: 'kb_dir', state: 'missing_kb' },
  { checkName: 'config_file', state: 'missing_config' },
  { checkName: 'datasources', state: 'missing_datasource' },
  { checkName: 'credentials', state: 'missing_creds' },
];

function errorMessageOrEmpty(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

function configCheck(ctx: AppContext, createdConfig: boolean): DoctorCheck {
  const exists = fs.existsSync(ctx.paths.runtimeConfigFile);
  const detail = createdConfig ? `${ctx.paths.runtimeConfigFile} (created)` : ctx.paths.runtimeConfigFile;
  return {
    check: 'config_file',
    status: exists ? DoctorStatus.Ok : DoctorStatus.Fail,
    detail,
  };
}

function kbCheck(ctx: AppContext): DoctorCheck {
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

async function daemonCheck(ctx: AppContext): Promise<DoctorCheck> {
  try {
    const socketPath = defaultSocketPath(ctx.paths.stateRoot);
    const reply = await rpcCall({ method: RpcMethod.DaemonStatus, socketPath, timeoutMs: DAEMON_PROBE_TIMEOUT_MS });
    if (!reply.ok) {
      throw new Error(nonEmptyOr(reply.error?.message, 'daemon unavailable'));
    }
    return { check: 'daemon', status: DoctorStatus.Ok, detail: `reachable via ${socketPath}` };
  } catch (error) {
    return {
      check: 'daemon',
      status: DoctorStatus.Warn,
      detail: nonEmptyOr(errorMessageOrEmpty(error), 'daemon unavailable'),
    };
  }
}

function datasourceNamesByCredentialRef(datasources: DatasourceProfile[]): Map<string, string[]> {
  const namesByRef = new Map<string, string[]>();
  for (const datasource of datasources) {
    const ref = textUnlessFalsy(datasource.credentialRef).trim();
    if (AUTH_REQUIRED_KINDS.has(datasource.kind) && ref !== '') {
      namesByRef.set(ref, [...(namesByRef.get(ref) ?? []), datasource.name]);
    }
  }
  return namesByRef;
}

async function findUnsetCredentialRefs(ctx: AppContext, namesByRef: Map<string, string[]>): Promise<string[]> {
  const unset: string[] = [];
  for (const [ref, names] of namesByRef) {
    const credentials = await ctx.credentialStore.get(ref);
    if (Object.keys(credentials).length === 0) {
      unset.push(`${ref} (${names.length} datasource(s))`);
    }
  }
  return unset;
}

function unsetCredentialRefsCheck(unset: string[]): DoctorCheck {
  return {
    check: 'credential_refs',
    status: unset.length > 0 ? DoctorStatus.Warn : DoctorStatus.Ok,
    detail: unset.length > 0
      ? `referenced but not set: ${unset.join('; ')} — set with \`taproot creds set --ref <ref>\``
      : 'all referenced credential refs resolve',
  };
}

async function credentialRefsCheck(ctx: AppContext, datasources: DatasourceProfile[]): Promise<DoctorCheck> {
  try {
    return unsetCredentialRefsCheck(await findUnsetCredentialRefs(ctx, datasourceNamesByCredentialRef(datasources)));
  } catch (error) {
    return { check: 'credential_refs', status: DoctorStatus.Fail, detail: errorMessageOrEmpty(error) };
  }
}

function credentialsCheck(ctx: AppContext, datasources: DatasourceProfile[]): DoctorCheck {
  const file = ctx.paths.credentialFile;
  if (fs.existsSync(file)) {
    return { check: 'credentials', status: DoctorStatus.Ok, detail: file };
  }
  if (datasources.length > 0 && !datasources.some((datasource) => AUTH_REQUIRED_KINDS.has(datasource.kind))) {
    const optionalKinds = [...new Set(datasources.filter((datasource) => AUTH_OPTIONAL_KINDS.has(datasource.kind)).map((datasource) => datasource.kind))];
    return {
      check: 'credentials',
      status: DoctorStatus.Ok,
      detail: optionalKinds.length > 0
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

function summarizeDatasources({ profiles, warnings }: { profiles: DatasourceProfile[]; warnings: string[] }): { datasources: DatasourceProfile[]; checks: DoctorCheck[] } {
  const countCheck: DoctorCheck = profiles.length > 0
    ? { check: 'datasources', status: DoctorStatus.Ok, detail: `${profiles.length} datasource profile(s)` }
    : { check: 'datasources', status: DoctorStatus.Warn, detail: 'none yet; add one with `taproot datasource add`' };
  if (warnings.length === 0) {
    return { datasources: profiles, checks: [countCheck] };
  }
  const skippedCheck: DoctorCheck = { check: 'skipped_datasources', status: DoctorStatus.Warn, detail: warnings.join('; ') };
  return { datasources: profiles, checks: [countCheck, skippedCheck] };
}

function loadDatasources(ctx: AppContext): { datasources: DatasourceProfile[]; checks: DoctorCheck[] } {
  try {
    return summarizeDatasources(ctx.datasourceStore.load());
  } catch (error) {
    return { datasources: [], checks: [{ check: 'datasources', status: DoctorStatus.Fail, detail: errorMessageOrEmpty(error) }] };
  }
}

function masterKeyCheck(ctx: AppContext): DoctorCheck {
  if ((process.env.TAPROOT_MASTER_KEY ?? '') !== '') {
    return { check: 'master_key', status: DoctorStatus.Ok, detail: 'TAPROOT_MASTER_KEY is set' };
  }
  if (!fs.existsSync(ctx.paths.credentialFile)) {
    return { check: 'master_key', status: DoctorStatus.Ok, detail: 'TAPROOT_MASTER_KEY is unset; the OS keychain holds credentials when available' };
  }
  return {
    check: 'master_key',
    status: DoctorStatus.Warn,
    detail: `${ctx.paths.credentialFile} is encrypted with a key derived from $USER that anyone on this machine can rebuild; set TAPROOT_MASTER_KEY (the next read re-encrypts the file) or store credentials in the OS keychain`,
  };
}

function computeReadiness(checks: DoctorCheck[]): ReadinessState {
  const statusByCheckName = new Map(checks.map((check) => [check.check, check.status]));
  const blocker = READINESS_BLOCKERS.find(({ checkName }) => (statusByCheckName.get(checkName) ?? DoctorStatus.Ok) !== DoctorStatus.Ok);
  return blocker === undefined ? 'ready' : blocker.state;
}

export async function collectReadinessSnapshot(
  ctx: AppContext,
  input?: { createdConfig?: boolean },
): Promise<ReadinessSnapshot> {
  const pluginNames = [...ctx.pluginRegistry.keys()];
  const { datasources, checks: datasourceChecks } = loadDatasources(ctx);
  const checks: DoctorCheck[] = [
    { check: 'node_version', status: DoctorStatus.Ok, detail: process.version },
    { check: 'state_root', status: fs.existsSync(ctx.paths.stateRoot) ? DoctorStatus.Ok : DoctorStatus.Fail, detail: ctx.paths.stateRoot },
    kbCheck(ctx),
    { check: 'plugins', status: DoctorStatus.Ok, detail: `${pluginNames.length} loaded: ${pluginNames.join(', ')}` },
    masterKeyCheck(ctx),
    configCheck(ctx, Boolean(input?.createdConfig)),
    ...datasourceChecks,
    credentialsCheck(ctx, datasources),
    await credentialRefsCheck(ctx, datasources),
    await daemonCheck(ctx),
  ];

  return { checks, readiness: computeReadiness(checks) };
}
