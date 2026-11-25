import { RUNTIME_CONSTANTS } from '../../core/constants.js';
import { DoctorStatus } from '../../types/plugin.js';
import type { DoctorCheck, TapRootPlugin } from '../../types/plugin.js';
import { connectorCheck } from '../_shared/connector-check.js';
import { firstNonEmpty, isNonEmpty } from '../../core/text-presence.js';
import { runShellCommand } from '../_shared/shell-command.js';

const DEFAULT_STATUS_COMMAND = 'tsh status';
const STATUS_CHECK_TIMEOUT_MS = RUNTIME_CONSTANTS.connector.statusCheckTimeoutMs;
const CONNECT_CHECK_TIMEOUT_MS = RUNTIME_CONSTANTS.connector.connectCheckTimeoutMs;
const TSH_STATUS_LINE = /^\s*(?:Cluster|Logged in as|Valid until|Profile URL):/u;
const UNRECOGNIZED_STATUS_MAX_CHARS = 200;

type ConnectorInput = Parameters<NonNullable<TapRootPlugin['doctor']>>[0];

function summarizeTshStatus(output: string): string {
  if (output === '' || output === 'ok') {
    return 'ok';
  }
  const statusLines = output.split(/\r?\n/u).filter((line) => TSH_STATUS_LINE.test(line)).map((line) => line.trim());
  return statusLines.length === 0 ? output.slice(0, UNRECOGNIZED_STATUS_MAX_CHARS) : statusLines.join(' | ');
}

function statusCommandOf(input: ConnectorInput): string {
  return firstNonEmpty(input.credentials.statusCommand) ?? DEFAULT_STATUS_COMMAND;
}

async function checkTshStatus(input: ConnectorInput): Promise<DoctorCheck[]> {
  const outcome = await runShellCommand(statusCommandOf(input), STATUS_CHECK_TIMEOUT_MS);
  const okDetail = summarizeTshStatus(outcome.detail);
  return [connectorCheck({ check: 'teleport status', outcome, failureStatus: DoctorStatus.Fail, failureCode: 'connector_status_blocked', okDetail })];
}

async function checkSessionStillValid(input: ConnectorInput): Promise<DoctorCheck[]> {
  const outcome = await runShellCommand(statusCommandOf(input), STATUS_CHECK_TIMEOUT_MS);
  return [
    connectorCheck({
      check: 'teleport login',
      outcome,
      failureStatus: DoctorStatus.Warn,
      failureCode: 'connector_login_command_missing',
      okDetail: 'session already valid',
      failureDetail: 'No loginCommand configured; tsh status failed',
    }),
  ];
}

async function runTshLogin(input: ConnectorInput): Promise<DoctorCheck[]> {
  const { loginCommand } = input.credentials;
  if (!isNonEmpty(loginCommand)) {
    return checkSessionStillValid(input);
  }
  const outcome = await runShellCommand(loginCommand, CONNECT_CHECK_TIMEOUT_MS);
  return [connectorCheck({ check: 'teleport login', outcome, failureStatus: DoctorStatus.Fail, failureCode: 'connector_connect_blocked' })];
}

export const teleportPlugin: TapRootPlugin = {
  manifest: {
    name: 'teleport',
    capabilities: ['doctor', 'resolveConnection'],
  },

  doctor: checkTshStatus,

  connect: runTshLogin,
};
