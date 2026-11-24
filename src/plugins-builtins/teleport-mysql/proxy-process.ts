import { once } from 'node:events';
import net from 'node:net';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { spawnErrorMessage } from '../../core/executor-errors.js';
import { connectivity } from '../../core/taproot-error.js';
import { LOOPBACK_HOST } from '../_shared/connection-endpoint.js';
import { waitMs } from '../../core/wait.js';

export type ProxyIdentity = {
  sessionId: string;
  target: string;
  user: string;
  database: string;
};

export type ProxyRuntime = {
  port: number;
  process: ChildProcess;
};

type ProxyProcessState = {
  stderr: string;
  spawnError: string;
  exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
};

const PROXY_READY_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 300;
const PROBE_INTERVAL_MS = 120;
const TERMINATE_GRACE_MS = 800;
const MISSING_TOOL_PREFIX = 'MISSING_TOOL:';

export function proxyUnavailableError(detail: string): Error {
  return connectivity(`teleport proxy path unavailable; ${detail}`);
}

async function reserveLocalPort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, LOOPBACK_HOST);
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : undefined;
  server.close();
  await once(server, 'close');
  if (port === undefined) {
    throw new Error('Failed to resolve free local port');
  }
  return port;
}

async function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (reachable: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.once('connect', () => {
      finish(true);
    });
    socket.once('error', () => {
      finish(false);
    });
    socket.setTimeout(PROBE_TIMEOUT_MS, () => {
      finish(false);
    });
  });
}

async function waitForTcpReady(port: number, failureOf: () => Error | undefined): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < PROXY_READY_TIMEOUT_MS) {
    const failure = failureOf();
    if (failure !== undefined) {
      throw failure;
    }
    if (await canConnect(LOOPBACK_HOST, port)) {
      return;
    }
    await waitMs(PROBE_INTERVAL_MS);
  }
  throw connectivity(`timed out waiting for teleport db proxy on ${LOOPBACK_HOST}:${port}`);
}

function monitorProxyProcess(proc: ChildProcess, onExit: () => void): ProxyProcessState {
  const state: ProxyProcessState = { stderr: '', spawnError: '', exit: undefined };
  proc.stderr?.on('data', (chunk) => {
    state.stderr += String(chunk);
  });
  proc.stdout?.resume();
  proc.once('error', (error) => {
    state.spawnError = spawnErrorMessage(error);
  });
  proc.once('exit', (code, signal) => {
    state.exit = { code, signal };
    onExit();
  });
  return state;
}

function exitDetail(state: ProxyProcessState, exit: NonNullable<ProxyProcessState['exit']>): string {
  const stderr = state.stderr.trim();
  return stderr === '' ? `tsh proxy db exited code=${exit.code} signal=${exit.signal ?? 'none'}` : stderr;
}

function processFailureError(state: ProxyProcessState, cause?: unknown): Error | undefined {
  if (state.spawnError !== '') {
    return state.spawnError.startsWith(MISSING_TOOL_PREFIX) ? new Error(state.spawnError, { cause }) : proxyUnavailableError(state.spawnError);
  }
  return state.exit === undefined ? undefined : proxyUnavailableError(exitDetail(state, state.exit));
}

function stderrFailureError(state: ProxyProcessState): Error | undefined {
  const stderr = state.stderr.trim();
  return stderr === '' ? undefined : proxyUnavailableError(stderr);
}

function hasExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

function killQuietly(proc: ChildProcess, signal: NodeJS.Signals): boolean {
  try {
    return proc.kill(signal);
  } catch {
    return false;
  }
}

async function terminate(proc: ChildProcess): Promise<void> {
  if (proc.killed || hasExited(proc) || !killQuietly(proc, 'SIGTERM')) {
    return;
  }
  await new Promise<void>((resolve) => {
    const forceKillTimer = setTimeout(() => {
      killQuietly(proc, 'SIGKILL');
      resolve();
    }, TERMINATE_GRACE_MS);
    proc.once('exit', () => {
      clearTimeout(forceKillTimer);
      resolve();
    });
  });
}

export async function stopProxy(proxy: ProxyRuntime): Promise<void> {
  await terminate(proxy.process);
}

export async function startProxy(identity: ProxyIdentity, onExit: () => void): Promise<ProxyRuntime> {
  const port = await reserveLocalPort();
  const args = ['proxy', 'db', '--tunnel', '--port', String(port), '--db-user', identity.user, '--db-name', identity.database, identity.target];
  const proc = spawn('tsh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const state = monitorProxyProcess(proc, onExit);
  const runtime = { port, process: proc };
  try {
    await waitForTcpReady(port, () => processFailureError(state));
    return runtime;
  } catch (error) {
    await stopProxy(runtime);
    throw processFailureError(state, error) ?? stderrFailureError(state) ?? error;
  }
}
