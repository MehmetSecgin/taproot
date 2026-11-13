import net from 'node:net';
import type { AppContext } from './app.js';
import { runDatasourceConnectors } from './connector-runner.js';
import { classifyError } from './error-classification.js';
import { DoctorStatus } from '../types/core.js';
import type { DatasourceProfile, DoctorCheck } from '../types/core.js';

export const DOCTOR_ALL_CONCURRENCY = 8;
export const TCP_TIMEOUT_MS = 3000;

export type TcpStatus = 'reachable' | 'refused' | 'timeout' | 'unresolved' | 'error';

export interface DoctorAllRow {
  datasource: string;
  kind: string;
  status: string;
  detail: string;
  code?: string;
  fix?: string;
}

export interface DoctorAllFilter {
  env: string;
  namespace?: string;
  kind?: string;
}

export function selectDatasources(all: DatasourceProfile[], filter: DoctorAllFilter): DatasourceProfile[] {
  return all.filter((d) =>
    d.env === filter.env
    && (!filter.namespace || d.namespace === filter.namespace)
    && (!filter.kind || d.kind === filter.kind));
}

export function tcpStatusOf(errorCode: string | undefined): TcpStatus {
  if (errorCode === 'ECONNREFUSED') return 'refused';
  if (errorCode === 'ETIMEDOUT') return 'timeout';
  if (errorCode === 'ENOTFOUND' || errorCode === 'EAI_AGAIN') return 'unresolved';
  return 'error';
}

export function probeTcp(host: string, port: number, timeoutMs = TCP_TIMEOUT_MS): Promise<{ status: TcpStatus; detail: string }> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (status: TcpStatus, detail: string) => {
      socket.destroy();
      resolve({ status, detail });
    };
    socket.setTimeout(timeoutMs, () => done('timeout', `no answer from ${host}:${port} within ${timeoutMs}ms`));
    socket.once('connect', () => done('reachable', `${host}:${port} accepted a TCP connection`));
    socket.once('error', (e: NodeJS.ErrnoException) => done(tcpStatusOf(e.code), e.message));
  });
}

function connectFix(ds: DatasourceProfile): string | undefined {
  return ds.connectors?.length ? `taproot doctor --datasource ${ds.name} --connect` : undefined;
}

async function tcpRow(ds: DatasourceProfile): Promise<DoctorAllRow> {
  const base = { datasource: ds.name, kind: ds.kind };
  if (!ds.connection.host || !ds.connection.port) {
    return { ...base, status: 'skipped', detail: 'no host and port on the profile; run without --tcp-only' };
  }
  const probe = await probeTcp(ds.connection.host, ds.connection.port);
  const fix = probe.status === 'reachable' ? undefined : connectFix(ds);
  return { ...base, ...probe, ...(fix ? { fix } : {}) };
}

async function fullRow(ctx: AppContext, ds: DatasourceProfile): Promise<DoctorAllRow> {
  const base = { datasource: ds.name, kind: ds.kind };
  const plugin = ctx.pluginRegistry.get(ds.kind);
  if (!plugin?.doctor) return { ...base, status: 'skipped', detail: `no doctor-capable plugin for kind '${ds.kind}'` };
  try {
    const creds = await ctx.credentialStore.get(ds.credentialRef);
    const input = { datasource: ds, credentialStore: ctx.credentialStore, pluginRegistry: ctx.pluginRegistry, mode: 'doctor' as const };
    const checks: DoctorCheck[] = await runDatasourceConnectors(input);
    checks.push(...(await plugin.doctor({ datasource: ds, credentials: creds })));
    const failed = checks.find((c) => c.status === DoctorStatus.Fail);
    if (!failed) return { ...base, status: 'reachable', detail: `${checks.length} check(s) ok` };
    const fix = connectFix(ds);
    return { ...base, status: 'fail', detail: `${failed.check}: ${failed.detail}`, code: classifyError(failed.detail), ...(fix ? { fix } : {}) };
  } catch (error) {
    const detail = (error as Error).message || String(error);
    return { ...base, status: 'fail', detail, code: classifyError(detail) };
  }
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function doctorAll(ctx: AppContext, datasources: DatasourceProfile[], tcpOnly: boolean): Promise<DoctorAllRow[]> {
  return mapLimited(datasources, DOCTOR_ALL_CONCURRENCY, (ds) => (tcpOnly ? tcpRow(ds) : fullRow(ctx, ds)));
}
