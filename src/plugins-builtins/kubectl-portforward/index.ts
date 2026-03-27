import { spawnSync } from 'node:child_process';
import type { DoctorCheck, TapRootPlugin } from '../../types/core.js';

function run(command: string): { ok: boolean; detail: string } {
  const proc = spawnSync('/bin/zsh', ['-lc', command], { encoding: 'utf8' });
  if (proc.status === 0) return { ok: true, detail: (proc.stdout || '').trim() || 'ok' };
  return { ok: false, detail: ((proc.stderr || proc.stdout || '').trim() || `exit=${proc.status}`).slice(0, 300) };
}

export const kubectlPortforwardPlugin: TapRootPlugin = {
  manifest: {
    name: 'kubectl-portforward',
    version: '0.1.0',
    kind: 'connector',
    capabilities: ['doctor', 'resolveConnection'],
    accessMethods: ['qa-portforward'],
    priority: 85,
  },

  async doctor(input): Promise<DoctorCheck[]> {
    const statusCommand = input.credentials.statusCommand || '';
    if (!statusCommand) {
      return [{ check: 'kubectl-portforward status', status: 'warn', detail: 'No statusCommand configured.', code: 'connector_status_command_missing' }];
    }
    const r = run(statusCommand);
    return [{ check: 'kubectl-portforward status', status: r.ok ? 'ok' : 'warn', detail: r.detail, ...(r.ok ? {} : { code: 'connector_status_blocked' }) }];
  },

  async connect(input): Promise<DoctorCheck[]> {
    const connectCommand = input.credentials.connectCommand || '';
    if (!connectCommand) {
      return [{ check: 'kubectl-portforward connect', status: 'warn', detail: 'No connectCommand configured.', code: 'connector_connect_command_missing' }];
    }
    const r = run(connectCommand);
    return [{ check: 'kubectl-portforward connect', status: r.ok ? 'ok' : 'fail', detail: r.detail, ...(r.ok ? {} : { code: 'connector_connect_blocked' }) }];
  },

  async disconnect(input): Promise<DoctorCheck[]> {
    const disconnectCommand = input.credentials.disconnectCommand || '';
    if (!disconnectCommand) {
      return [
        {
          check: 'kubectl-portforward disconnect',
          status: 'warn',
          detail: 'No disconnectCommand configured.',
          code: 'connector_disconnect_command_missing',
        },
      ];
    }
    const r = run(disconnectCommand);
    return [{ check: 'kubectl-portforward disconnect', status: r.ok ? 'ok' : 'fail', detail: r.detail, ...(r.ok ? {} : { code: 'connector_disconnect_blocked' }) }];
  },
};
