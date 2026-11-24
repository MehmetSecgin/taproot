import { RUNTIME_CONSTANTS } from '../../core/constants.js';
import { DoctorStatus } from '../../types/plugin.js';
import type { DoctorCheck, TapRootPlugin } from '../../types/plugin.js';
import { connectorCheck } from '../_shared/connector-check.js';
import { isNonEmpty } from '../../core/text-presence.js';
import { runShellCommand } from '../_shared/shell-command.js';

type ConnectorInput = Parameters<NonNullable<TapRootPlugin['doctor']>>[0];

async function checkPortforwardStatus(input: ConnectorInput): Promise<DoctorCheck[]> {
  const { statusCommand } = input.credentials;
  if (!isNonEmpty(statusCommand)) {
    return [{ check: 'kubectl-portforward status', status: DoctorStatus.Warn, detail: 'No statusCommand configured.', code: 'connector_status_command_missing' }];
  }
  const outcome = await runShellCommand(statusCommand, RUNTIME_CONSTANTS.connector.statusCheckTimeoutMs);
  return [connectorCheck({ check: 'kubectl-portforward status', outcome, failureStatus: DoctorStatus.Warn, failureCode: 'connector_status_blocked' })];
}

async function runPortforwardConnect(input: ConnectorInput): Promise<DoctorCheck[]> {
  const { connectCommand } = input.credentials;
  if (!isNonEmpty(connectCommand)) {
    return [{ check: 'kubectl-portforward connect', status: DoctorStatus.Warn, detail: 'No connectCommand configured.', code: 'connector_connect_command_missing' }];
  }
  const outcome = await runShellCommand(connectCommand, RUNTIME_CONSTANTS.connector.connectCheckTimeoutMs);
  return [connectorCheck({ check: 'kubectl-portforward connect', outcome, failureStatus: DoctorStatus.Fail, failureCode: 'connector_connect_blocked' })];
}

export const kubectlPortforwardPlugin: TapRootPlugin = {
  manifest: {
    name: 'kubectl-portforward',
    capabilities: ['doctor', 'resolveConnection'],
  },

  doctor: checkPortforwardStatus,

  connect: runPortforwardConnect,
};
