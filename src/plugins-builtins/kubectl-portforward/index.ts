import { RUNTIME_CONSTANTS } from '../../core/constants.js';
import { DoctorStatus } from '../../types/core.js';
import type { DoctorCheck, TapRootPlugin } from '../../types/core.js';
import { runShellCommand } from '../shell-command.js';

export const kubectlPortforwardPlugin: TapRootPlugin = {
  manifest: {
    name: 'kubectl-portforward',
    capabilities: ['doctor', 'resolveConnection'],
  },

  async doctor(input): Promise<DoctorCheck[]> {
    const statusCommand = input.credentials.statusCommand || '';
    if (!statusCommand) {
      return [{ check: 'kubectl-portforward status', status: DoctorStatus.Warn, detail: 'No statusCommand configured.', code: 'connector_status_command_missing' }];
    }
    const r = await runShellCommand(statusCommand, RUNTIME_CONSTANTS.connector.statusCheckTimeoutMs);
    return [{ check: 'kubectl-portforward status', status: r.ok ? 'ok' : 'warn', detail: r.detail, ...(r.ok ? {} : { code: 'connector_status_blocked' }) }];
  },

  async connect(input): Promise<DoctorCheck[]> {
    const connectCommand = input.credentials.connectCommand || '';
    if (!connectCommand) {
      return [{ check: 'kubectl-portforward connect', status: DoctorStatus.Warn, detail: 'No connectCommand configured.', code: 'connector_connect_command_missing' }];
    }
    const r = await runShellCommand(connectCommand, RUNTIME_CONSTANTS.connector.connectCheckTimeoutMs);
    return [{ check: 'kubectl-portforward connect', status: r.ok ? 'ok' : 'fail', detail: r.detail, ...(r.ok ? {} : { code: 'connector_connect_blocked' }) }];
  },
};
