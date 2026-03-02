import { spawnSync } from 'node:child_process';
import type { DoctorCheck, TelequeryPlugin } from '../../types/core.js';

function run(command: string): { ok: boolean; detail: string } {
  const proc = spawnSync('/bin/zsh', ['-lc', command], { encoding: 'utf8' });
  if (proc.status === 0) return { ok: true, detail: (proc.stdout || '').trim() || 'ok' };
  return { ok: false, detail: ((proc.stderr || proc.stdout || '').trim() || `exit=${proc.status}`).slice(0, 400) };
}

export const teleportPlugin: TelequeryPlugin = {
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
    const r = run(statusCommand);
    return [{ check: 'teleport status', status: r.ok ? 'ok' : 'fail', detail: r.detail }];
  },

  async connect(input): Promise<DoctorCheck[]> {
    const loginCommand = input.credentials.loginCommand;
    if (!loginCommand) {
      const check = run(input.credentials.statusCommand || 'tsh status');
      return [{ check: 'teleport login', status: check.ok ? 'ok' : 'warn', detail: check.ok ? 'session already valid' : 'No loginCommand configured; tsh status failed' }];
    }
    const r = run(loginCommand);
    return [{ check: 'teleport login', status: r.ok ? 'ok' : 'fail', detail: r.detail }];
  },
};
