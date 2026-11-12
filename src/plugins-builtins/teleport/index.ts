import { RUNTIME_CONSTANTS } from '../../core/constants.js';
import type { DoctorCheck, TapRootPlugin } from '../../types/core.js';
import { str } from '../../core/strings.js';
import { runShellCommand } from '../shell-command.js';

const STATUS_TIMEOUT_MS = RUNTIME_CONSTANTS.connector.statusCheckTimeoutMs;
const LOGIN_TIMEOUT_MS = RUNTIME_CONSTANTS.connector.connectCheckTimeoutMs;

function summarizeTshStatus(detail: string, ok: boolean): string {
  if (!ok) return str(detail).slice(0, 400);
  const text = str(detail);
  if (!text || text === 'ok') return 'ok';
  const want = /^\s*(Cluster|Logged in as|Valid until|Profile URL):/;
  const lines = text.split(/\r?\n/).filter((line) => want.test(line)).map((line) => line.trim());
  if (!lines.length) return text.slice(0, 200);
  return lines.join(' | ');
}

export const teleportPlugin: TapRootPlugin = {
  manifest: {
    name: 'teleport',
    kind: 'connector',
    capabilities: ['doctor', 'resolveConnection'],
    priority: 90,
  },

  async doctor(input): Promise<DoctorCheck[]> {
    const statusCommand = input.credentials.statusCommand || 'tsh status';
    const r = await runShellCommand(statusCommand, STATUS_TIMEOUT_MS);
    return [{ check: 'teleport status', status: r.ok ? 'ok' : 'fail', detail: summarizeTshStatus(r.detail, r.ok), ...(r.ok ? {} : { code: 'connector_status_blocked' }) }];
  },

  async connect(input): Promise<DoctorCheck[]> {
    const loginCommand = input.credentials.loginCommand;
    if (!loginCommand) {
      const check = await runShellCommand(input.credentials.statusCommand || 'tsh status', STATUS_TIMEOUT_MS);
      return [
        {
          check: 'teleport login',
          status: check.ok ? 'ok' : 'warn',
          detail: check.ok ? 'session already valid' : 'No loginCommand configured; tsh status failed',
          ...(!check.ok ? { code: 'connector_login_command_missing' } : {}),
        },
      ];
    }
    const r = await runShellCommand(loginCommand, LOGIN_TIMEOUT_MS);
    return [{ check: 'teleport login', status: r.ok ? 'ok' : 'fail', detail: r.detail, ...(r.ok ? {} : { code: 'connector_connect_blocked' }) }];
  },
};
