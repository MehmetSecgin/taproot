import { spawn } from 'node:child_process';
import { AccessMethod, DoctorStatus } from '../../types/core.js';
import type { DoctorCheck, TapRootPlugin } from '../../types/core.js';
import { RUNTIME_CONSTANTS } from '../../core/constants.js';

async function runAsync(command: string, timeoutMs: number): Promise<{ ok: boolean; detail: string; timedOut: boolean }> {
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

const DEFAULT_STATUS_COMMAND =
  'log="$HOME/Library/Application Support/OpenVPN Connect/log/ovpn.log"; [ -f "$log" ] && ev=$(LC_ALL=C grep -E "EVENT: (CONNECTED|DISCONNECTED)" "$log" | tail -n1) && echo "$ev" | grep -q "EVENT: CONNECTED"';

const DEFAULT_CONNECT_COMMAND =
  '"/Applications/OpenVPN Connect.app/Contents/MacOS/OpenVPN Connect" --set-setting=launch-options --value=connect-latest >/dev/null 2>&1 || true; "/Applications/OpenVPN Connect.app/Contents/MacOS/OpenVPN Connect" --minimize --skip-startup-dialogs >/dev/null 2>&1 || true';

const DEFAULT_DISCONNECT_COMMAND =
  '"/Applications/OpenVPN Connect.app/Contents/MacOS/OpenVPN Connect" --quit >/dev/null 2>&1 || true';

const STATUS_TIMEOUT_MS = RUNTIME_CONSTANTS.plugin.openvpnStatusTimeoutMs;
const COMMAND_TIMEOUT_MS = RUNTIME_CONSTANTS.plugin.openvpnCommandTimeoutMs;
const POLL_INTERVAL_MS = 500;

async function pollUntilConnected(statusCommand: string, deadlineAt: number): Promise<{ ok: boolean; detail: string }> {
  let lastDetail = 'not connected';
  while (Date.now() < deadlineAt) {
    const r = await runAsync(statusCommand, STATUS_TIMEOUT_MS);
    if (r.ok) return { ok: true, detail: r.detail };
    lastDetail = r.detail;
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)));
  }
  return { ok: false, detail: lastDetail };
}

export const openvpnPlugin: TapRootPlugin = {
  manifest: {
    name: 'openvpn',
    version: '0.1.0',
    kind: 'connector',
    capabilities: ['doctor', 'resolveConnection'],
    accessMethods: [AccessMethod.Native, AccessMethod.QaPortforward, AccessMethod.Tsh],
    priority: 80,
  },

  async doctor(input): Promise<DoctorCheck[]> {
    const statusCommand = input.credentials.statusCommand || DEFAULT_STATUS_COMMAND;
    const r = await runAsync(statusCommand, STATUS_TIMEOUT_MS);
    return [{ check: 'openvpn status', status: r.ok ? 'ok' : 'warn', detail: r.detail, ...(r.ok ? {} : { code: 'connector_status_blocked' }) }];
  },

  async connect(input): Promise<DoctorCheck[]> {
    const statusCommand = input.credentials.statusCommand || DEFAULT_STATUS_COMMAND;
    const pre = await runAsync(statusCommand, STATUS_TIMEOUT_MS);
    if (pre.ok) {
      return [{ check: 'openvpn connect', status: DoctorStatus.Ok, detail: 'already connected' }];
    }

    const connectCommand = input.credentials.connectCommand || DEFAULT_CONNECT_COMMAND;
    const started = await runAsync(connectCommand, COMMAND_TIMEOUT_MS);

    const waitMs = Number(input.credentials.connectWaitMs || 10000);
    const deadlineAt = Date.now() + Math.max(1000, waitMs);
    const post = await pollUntilConnected(statusCommand, deadlineAt);
    if (post.ok) {
      return [{ check: 'openvpn connect', status: DoctorStatus.Ok, detail: 'connected' }];
    }

    if (started.ok) {
      return [
        {
          check: 'openvpn connect',
          status: DoctorStatus.Fail,
          detail: 'connect command executed but VPN did not report connected state',
          code: 'connector_connect_blocked',
        },
      ];
    }
    return [{ check: 'openvpn connect', status: DoctorStatus.Fail, detail: started.detail, code: 'connector_connect_blocked' }];
  },

  async disconnect(input): Promise<DoctorCheck[]> {
    const disconnectCommand = input.credentials.disconnectCommand || DEFAULT_DISCONNECT_COMMAND;
    const r = await runAsync(disconnectCommand, COMMAND_TIMEOUT_MS);
    return [{ check: 'openvpn disconnect', status: r.ok ? 'ok' : 'fail', detail: r.detail, ...(r.ok ? {} : { code: 'connector_disconnect_blocked' }) }];
  },
};
