import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from './app.js';
import { DoctorStatus } from '../types/core.js';
import type { DoctorCheck } from '../types/core.js';
import { defaultSocketPath, rpcCall } from '../daemon/client.js';
import { RpcMethod } from '../daemon/types.js';
import { str } from './strings.js';

export type ReadinessState = 'ready' | 'missing_kb' | 'missing_config' | 'missing_datasource' | 'missing_creds';

export interface ReadinessSnapshot {
  checks: DoctorCheck[];
  readiness: ReadinessState;
}

const AUTH_OPTIONAL_KINDS = new Set(['redis']);

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

const AUTH_REQUIRED_KINDS = new Set(['mysql', 'teleport-mysql']);

async function credentialRefsCheck(ctx: AppContext): Promise<DoctorCheck> {
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

function credentialsCheck(ctx: AppContext): DoctorCheck {
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

function computeReadiness(checks: DoctorCheck[]): ReadinessState {
  const byName = new Map(checks.map((check) => [check.check, check]));
  if ((byName.get('kb_dir')?.status || DoctorStatus.Ok) !== DoctorStatus.Ok) return 'missing_kb';
  if ((byName.get('config_file')?.status || DoctorStatus.Ok) !== DoctorStatus.Ok) return 'missing_config';
  if ((byName.get('datasources')?.status || DoctorStatus.Ok) !== DoctorStatus.Ok) return 'missing_datasource';
  if ((byName.get('credentials')?.status || DoctorStatus.Ok) !== DoctorStatus.Ok) return 'missing_creds';
  return 'ready';
}

export async function collectReadinessSnapshot(
  ctx: AppContext,
  input?: { createdConfig?: boolean },
): Promise<ReadinessSnapshot> {
  const pluginNames = [...ctx.pluginRegistry.keys()];
  const datasources = ctx.datasourceStore.list();
  const checks: DoctorCheck[] = [
    { check: 'node_version', status: DoctorStatus.Ok, detail: process.version },
    { check: 'state_root', status: fs.existsSync(ctx.paths.stateRoot) ? DoctorStatus.Ok : DoctorStatus.Fail, detail: ctx.paths.stateRoot },
    kbCheck(ctx),
    { check: 'plugins', status: DoctorStatus.Ok, detail: `${pluginNames.length} loaded: ${pluginNames.join(', ')}` },
    {
      check: 'master_key',
      status: DoctorStatus.Ok,
      detail: process.env.TAPROOT_MASTER_KEY ? 'TAPROOT_MASTER_KEY is set' : 'TAPROOT_MASTER_KEY is unset (optional); the credential fallback file uses a key derived from $USER',
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

  return { checks, readiness: computeReadiness(checks) };
}
