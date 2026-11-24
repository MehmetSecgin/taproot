import { setTimeout as delay } from 'node:timers/promises';
import { RUNTIME_CONSTANTS } from './constants.js';
import { errorText } from './error-text.js';
import { DoctorStatus } from '../types/plugin.js';
import type { DatasourceProfile } from '../types/datasource.js';
import type { DoctorCheck, DoctorCheckCode, PluginRegistry } from '../types/plugin.js';
import type { CredentialStore } from '../store/credentials.js';
import { textUnlessFalsy } from './text-presence.js';

type ConnectorMode = 'doctor' | 'connect';

type ConnectorRunInput = {
  datasource: DatasourceProfile;
  credentialStore: Pick<CredentialStore, 'get'>;
  pluginRegistry: PluginRegistry;
  mode: ConnectorMode;
};

type TimedConnectorCheck = {
  connectorName: string;
  mode: ConnectorMode;
  timeoutMs: number;
  runCheck: () => Promise<DoctorCheck[]>;
};

const MAX_FAILURE_DETAIL_LENGTH = 400;

const inFlightConnects = new Map<string, Promise<DoctorCheck[]>>();
const recentConnectSuccesses = new Map<string, { checks: DoctorCheck[]; reusableUntil: number }>();

function failureText(reason: unknown): string {
  const text = errorText(reason);
  return text === '' ? String(reason) : text;
}

function connectorFailureCheck(connectorName: string, message: string, code: DoctorCheckCode): DoctorCheck {
  return {
    check: `connector:${connectorName}`,
    status: DoctorStatus.Fail,
    detail: message.slice(0, MAX_FAILURE_DETAIL_LENGTH),
    code,
  };
}

function connectorWarnCheck(connectorName: string, detail: string, code: DoctorCheckCode): DoctorCheck {
  return { check: `connector:${connectorName}`, status: DoctorStatus.Warn, detail, code };
}

async function failAfterTimeout(check: TimedConnectorCheck, signal: AbortSignal): Promise<never> {
  await delay(check.timeoutMs, null, { signal });
  throw new Error(`connector_timeout: ${check.connectorName} ${check.mode} exceeded ${check.timeoutMs}ms`);
}

async function runWithConnectorTimeout(check: TimedConnectorCheck): Promise<DoctorCheck[]> {
  const cancelTimeout = new AbortController();
  try {
    return await Promise.race<DoctorCheck[]>([check.runCheck(), failAfterTimeout(check, cancelTimeout.signal)]);
  } catch (error) {
    const message = failureText(error);
    const code = message.startsWith('connector_timeout') ? 'connector_timeout' : 'connector_check_failed';
    return [connectorFailureCheck(check.connectorName, message, code)];
  } finally {
    cancelTimeout.abort();
  }
}

function connectKey(datasource: DatasourceProfile): string {
  return JSON.stringify([datasource.name, datasource.connectors, datasource.connection, datasource.resolverHints]);
}

async function runConnector(input: ConnectorRunInput, connectorName: string): Promise<DoctorCheck[]> {
  const plugin = input.pluginRegistry.get(connectorName);
  if (!plugin) {
    return [connectorWarnCheck(connectorName, 'connector plugin not found', 'connector_plugin_missing')];
  }
  const credentialRef = textUnlessFalsy(input.datasource.resolverHints?.[`${connectorName}CredentialRef`]).trim();
  const credentials = credentialRef === '' ? {} : await input.credentialStore.get(credentialRef);
  const runPluginCheck = input.mode === 'doctor' ? plugin.doctor?.bind(plugin) : plugin.connect?.bind(plugin);
  if (!runPluginCheck) {
    return [connectorWarnCheck(connectorName, `mode '${input.mode}' not supported by plugin`, 'connector_mode_unsupported')];
  }
  const timeoutMs = input.mode === 'connect'
    ? RUNTIME_CONSTANTS.connector.connectCheckTimeoutMs
    : RUNTIME_CONSTANTS.connector.statusCheckTimeoutMs;
  return runWithConnectorTimeout({
    connectorName,
    mode: input.mode,
    timeoutMs,
    runCheck: async () => runPluginCheck({ datasource: input.datasource, credentials }),
  });
}

async function runConnectorsUncached(input: ConnectorRunInput): Promise<DoctorCheck[]> {
  const connectorNames = input.datasource.connectors ?? [];
  const checksPerConnector = await Promise.all(connectorNames.map(async (connectorName) => {
    try {
      return await runConnector(input, connectorName);
    } catch (error) {
      return [connectorFailureCheck(connectorName, failureText(error), 'connector_check_failed')];
    }
  }));
  return checksPerConnector.flat();
}

async function connectAndRemember(input: ConnectorRunInput, key: string): Promise<DoctorCheck[]> {
  try {
    const checks = await runConnectorsUncached(input);
    if (checks.every((check) => check.status === DoctorStatus.Ok)) {
      recentConnectSuccesses.set(key, { checks, reusableUntil: Date.now() + RUNTIME_CONSTANTS.connector.connectReuseMs });
    }
    return checks;
  } finally {
    inFlightConnects.delete(key);
  }
}

function freshConnectSuccess(key: string): DoctorCheck[] | undefined {
  const recentSuccess = recentConnectSuccesses.get(key);
  return recentSuccess && recentSuccess.reusableUntil > Date.now() ? recentSuccess.checks : undefined;
}

export async function runDatasourceConnectors(input: ConnectorRunInput): Promise<DoctorCheck[]> {
  if (input.mode === 'doctor') {
    return runConnectorsUncached(input);
  }
  const key = connectKey(input.datasource);
  const reusable = freshConnectSuccess(key) ?? inFlightConnects.get(key);
  if (reusable) {
    return reusable;
  }
  const connecting = connectAndRemember(input, key);
  inFlightConnects.set(key, connecting);
  return connecting;
}

export function connectorFailureSummary(checks: DoctorCheck[]): string | undefined {
  const failedChecks = checks.filter((check) => check.status === DoctorStatus.Fail);
  return failedChecks.length === 0 ? undefined : failedChecks.map((check) => check.detail).join(' | ');
}
