import { spawnSync } from 'node:child_process';
import type { DoctorCheck, TelequeryPlugin } from '../../types/core.js';

function run(command: string): { ok: boolean; detail: string } {
  const proc = spawnSync('/bin/zsh', ['-lc', command], { encoding: 'utf8' });
  if (proc.status === 0) return { ok: true, detail: (proc.stdout || '').trim() || 'ok' };
  return { ok: false, detail: ((proc.stderr || proc.stdout || '').trim() || `exit=${proc.status}`).slice(0, 400) };
}

export const openvpnPlugin: TelequeryPlugin = {
  manifest: {
    name: 'openvpn',
    version: '0.1.0',
    kind: 'connector',
    capabilities: ['doctor', 'resolveConnection'],
    accessMethods: ['native', 'qa-portforward', 'tsh'],
    priority: 80,
  },

  async doctor(input): Promise<DoctorCheck[]> {
    const statusCommand = input.credentials.statusCommand || 'openvpn3 sessions-list';
    const r = run(statusCommand);
    return [{ check: 'openvpn status', status: r.ok ? 'ok' : 'warn', detail: r.detail }];
  },

  async connect(input): Promise<DoctorCheck[]> {
    const connectCommand = input.credentials.connectCommand;
    if (!connectCommand) {
      return [{ check: 'openvpn connect', status: 'warn', detail: 'No connectCommand configured in connector credential ref.' }];
    }
    const r = run(connectCommand);
    return [{ check: 'openvpn connect', status: r.ok ? 'ok' : 'fail', detail: r.detail }];
  },

  async disconnect(input): Promise<DoctorCheck[]> {
    const disconnectCommand = input.credentials.disconnectCommand;
    if (!disconnectCommand) {
      return [{ check: 'openvpn disconnect', status: 'warn', detail: 'No disconnectCommand configured in connector credential ref.' }];
    }
    const r = run(disconnectCommand);
    return [{ check: 'openvpn disconnect', status: r.ok ? 'ok' : 'fail', detail: r.detail }];
  },
};
