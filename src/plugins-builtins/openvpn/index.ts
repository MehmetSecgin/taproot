import { spawnSync } from 'node:child_process';
import type { DoctorCheck, TapRootPlugin } from '../../types/core.js';

function run(command: string): { ok: boolean; detail: string } {
  const proc = spawnSync('/bin/zsh', ['-lc', command], { encoding: 'utf8' });
  if (proc.status === 0) return { ok: true, detail: (proc.stdout || '').trim() || 'ok' };
  return { ok: false, detail: ((proc.stderr || proc.stdout || '').trim() || `exit=${proc.status}`).slice(0, 400) };
}

const DEFAULT_STATUS_COMMAND =
  'log="$HOME/Library/Application Support/OpenVPN Connect/log/ovpn.log"; [ -f "$log" ] && ev=$(LC_ALL=C grep -E "EVENT: (CONNECTED|DISCONNECTED)" "$log" | tail -n1) && echo "$ev" | grep -q "EVENT: CONNECTED"';

const DEFAULT_CONNECT_COMMAND =
  '"/Applications/OpenVPN Connect.app/Contents/MacOS/OpenVPN Connect" --set-setting=launch-options --value=connect-latest >/dev/null 2>&1 || true; "/Applications/OpenVPN Connect.app/Contents/MacOS/OpenVPN Connect" --minimize --skip-startup-dialogs >/dev/null 2>&1 || true';

const DEFAULT_DISCONNECT_COMMAND =
  '"/Applications/OpenVPN Connect.app/Contents/MacOS/OpenVPN Connect" --quit >/dev/null 2>&1 || true';

function waitUntilConnected(statusCommand: string, attempts = 20, sleepSeconds = 1): { ok: boolean; detail: string } {
  const loop = `for _ in $(seq 1 ${attempts}); do ${statusCommand} && exit 0; sleep ${sleepSeconds}; done; exit 1`;
  return run(loop);
}

export const openvpnPlugin: TapRootPlugin = {
  manifest: {
    name: 'openvpn',
    version: '0.1.0',
    kind: 'connector',
    capabilities: ['doctor', 'resolveConnection'],
    accessMethods: ['native', 'qa-portforward', 'tsh'],
    priority: 80,
  },

  async doctor(input): Promise<DoctorCheck[]> {
    const statusCommand = input.credentials.statusCommand || DEFAULT_STATUS_COMMAND;
    const r = run(statusCommand);
    return [{ check: 'openvpn status', status: r.ok ? 'ok' : 'warn', detail: r.detail }];
  },

  async connect(input): Promise<DoctorCheck[]> {
    const statusCommand = input.credentials.statusCommand || DEFAULT_STATUS_COMMAND;
    const pre = run(statusCommand);
    if (pre.ok) {
      return [{ check: 'openvpn connect', status: 'ok', detail: 'already connected' }];
    }

    const connectCommand = input.credentials.connectCommand || DEFAULT_CONNECT_COMMAND;
    const started = run(connectCommand);

    const post = waitUntilConnected(statusCommand);
    if (post.ok) {
      return [{ check: 'openvpn connect', status: 'ok', detail: 'connected' }];
    }

    if (started.ok) {
      return [{ check: 'openvpn connect', status: 'fail', detail: 'connect command executed but VPN did not report connected state' }];
    }
    return [{ check: 'openvpn connect', status: 'fail', detail: started.detail }];
  },

  async disconnect(input): Promise<DoctorCheck[]> {
    const disconnectCommand = input.credentials.disconnectCommand || DEFAULT_DISCONNECT_COMMAND;
    const r = run(disconnectCommand);
    return [{ check: 'openvpn disconnect', status: r.ok ? 'ok' : 'fail', detail: r.detail }];
  },
};
