import { spawn } from 'node:child_process';
import { RUNTIME_CONSTANTS } from '../../core/constants.js';
import type { DoctorCheck, TapRootPlugin } from '../../types/core.js';

const STATUS_TIMEOUT_MS = RUNTIME_CONSTANTS.connector.statusCheckTimeoutMs;
const LOGIN_TIMEOUT_MS = RUNTIME_CONSTANTS.connector.connectCheckTimeoutMs;

function summarizeTshStatus(detail: string, ok: boolean): string {
  if (!ok) return String(detail || '').slice(0, 400);
  const text = String(detail || '');
  if (!text || text === 'ok') return 'ok';
  const want = /^\s*(Cluster|Logged in as|Valid until|Profile URL):/;
  const lines = text.split(/\r?\n/).filter((line) => want.test(line)).map((line) => line.trim());
  if (!lines.length) return text.slice(0, 200);
  return lines.join(' | ');
}

async function run(command: string, timeoutMs: number): Promise<{ ok: boolean; detail: string; timedOut: boolean }> {
  return await new Promise((resolve) => {
    const proc = spawn('/bin/sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: { ok: boolean; detail: string; timedOut: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (!proc.killed) proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, detail: `command timed out after ${timeoutMs}ms`, timedOut: true });
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    proc.once('error', (error) => {
      finish({ ok: false, detail: ((error as Error).message || 'spawn error').slice(0, 400), timedOut: false });
    });
    proc.once('exit', (code) => {
      if (code === 0) {
        finish({ ok: true, detail: stdout.trim() || 'ok', timedOut: false });
        return;
      }
      const detail = (stderr.trim() || stdout.trim() || `exit=${code}`).slice(0, 400);
      finish({ ok: false, detail, timedOut: false });
    });
  });
}

export const teleportPlugin: TapRootPlugin = {
  manifest: {
    name: 'teleport',
    version: '0.1.0',
    kind: 'connector',
    capabilities: ['doctor', 'resolveConnection'],
    accessMethods: ['tsh'],
    priority: 90,
  },

  async doctor(input): Promise<DoctorCheck[]> {
    const statusCommand = input.credentials.statusCommand || 'tsh status';
    const r = await run(statusCommand, STATUS_TIMEOUT_MS);
    return [{ check: 'teleport status', status: r.ok ? 'ok' : 'fail', detail: summarizeTshStatus(r.detail, r.ok), ...(r.ok ? {} : { code: 'connector_status_blocked' }) }];
  },

  async connect(input): Promise<DoctorCheck[]> {
    const loginCommand = input.credentials.loginCommand;
    if (!loginCommand) {
      const check = await run(input.credentials.statusCommand || 'tsh status', STATUS_TIMEOUT_MS);
      return [
        {
          check: 'teleport login',
          status: check.ok ? 'ok' : 'warn',
          detail: check.ok ? 'session already valid' : 'No loginCommand configured; tsh status failed',
          ...(!check.ok ? { code: 'connector_login_command_missing' } : {}),
        },
      ];
    }
    const r = await run(loginCommand, LOGIN_TIMEOUT_MS);
    return [{ check: 'teleport login', status: r.ok ? 'ok' : 'fail', detail: r.detail, ...(r.ok ? {} : { code: 'connector_connect_blocked' }) }];
  },
};
