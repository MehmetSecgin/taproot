import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from './app.js';
import { defaultSocketPath, rpcCall } from '../daemon/client.js';

export type ReadinessState = 'ready' | 'missing_kb' | 'missing_config' | 'missing_datasource' | 'missing_creds';
export type ReadinessCheckStatus = 'ok' | 'warn' | 'fail';

export interface ReadinessCheck {
  check: string;
  status: ReadinessCheckStatus;
  detail: string;
}

export interface ReadinessSnapshot {
  checks: ReadinessCheck[];
  readiness: ReadinessState;
  nextActions: string[];
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

export function nextActionsForReadiness(readiness: ReadinessState): string[] {
  switch (readiness) {
    case 'missing_kb':
      return [
        'Set OBSIDIAN_MEMORY_ROOT to a memory root that contains domains/engineering/references/db-kb, then rerun: taproot --json init',
      ];
    case 'missing_config':
      return ['Run: taproot --json init'];
    case 'missing_datasource':
      return ['Create a datasource with taproot --json init datasource --env <env> --service <service> or taproot --json datasource add ...'];
    case 'missing_creds':
      return ['Store credentials with taproot --json creds set --ref <ref> --user <user> --password <password>'];
    default:
      return [];
  }
}

export function nextCommandForReadiness(readiness: ReadinessState): string | null {
  switch (readiness) {
    case 'missing_kb':
      return 'taproot --json init';
    case 'missing_config':
      return 'taproot --json init';
    case 'missing_datasource':
      return 'taproot --json datasource add ...';
    case 'missing_creds':
      return 'taproot --json creds set --ref <ref> --user <user> --password <password>';
    default:
      return null;
  }
}

export async function collectReadinessSnapshot(ctx: AppContext, input?: { createdConfig?: boolean }): Promise<ReadinessSnapshot> {
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

  const readiness = computeReadiness(checks);
  const nextActions = nextActionsForReadiness(readiness);
  if (!process.env.TAPROOT_MASTER_KEY) {
    nextActions.push('Set TAPROOT_MASTER_KEY to avoid using the fallback credential encryption secret');
  }
  if (checks.find((check) => check.check === 'daemon')?.status !== 'ok') {
    nextActions.push('Start the daemon with: taproot --json daemon start');
  }

  return { checks, readiness, nextActions };
}
