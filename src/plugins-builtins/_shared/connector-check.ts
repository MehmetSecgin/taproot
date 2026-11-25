import { DoctorStatus } from '../../types/plugin.js';
import type { DoctorCheck, DoctorCheckCode } from '../../types/plugin.js';
import type { ShellCommandOutcome } from './shell-command.js';

type ConnectorCheckInput = {
  check: string;
  outcome: ShellCommandOutcome;
  failureStatus: DoctorStatus;
  failureCode: DoctorCheckCode;
  okDetail?: string;
  failureDetail?: string;
};

export function connectorCheck(input: ConnectorCheckInput): DoctorCheck {
  const { check, outcome } = input;
  if (outcome.ok) {
    return { check, status: DoctorStatus.Ok, detail: input.okDetail ?? outcome.detail };
  }
  return { check, status: input.failureStatus, detail: input.failureDetail ?? outcome.detail, code: input.failureCode };
}
