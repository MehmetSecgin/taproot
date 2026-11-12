import { RUNTIME_CONSTANTS } from './constants.js';
import type { PluginRegistry } from '../plugins/load-builtins.js';
import { DoctorStatus } from '../types/core.js';
import type { DatasourceProfile, DoctorCheck } from '../types/core.js';
import { str } from './strings.js';

async function withConnectorTimeout(name: string, mode: string, timeoutMs: number, run: () => Promise<DoctorCheck[]>): Promise<DoctorCheck[]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<DoctorCheck[]>([
      run(),
      new Promise<DoctorCheck[]>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`connector_timeout: ${name} ${mode} exceeded ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    const message = (error as Error).message || String(error);
    return [
      {
        check: `connector:${name}`,
        status: DoctorStatus.Fail,
        detail: message.slice(0, 400),
        code: message.startsWith('connector_timeout') ? 'connector_timeout' : 'connector_check_failed',
      },
    ];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface ConnectorRunInput {
  datasource: DatasourceProfile;
  credentialStore: { get: (ref: string) => Promise<Record<string, string>> };
  pluginRegistry: PluginRegistry;
  mode: 'doctor' | 'connect';
}

const connectsInFlight = new Map<string, Promise<DoctorCheck[]>>();
const connectSuccesses = new Map<string, { checks: DoctorCheck[]; reusableUntil: number }>();

function connectKey(datasource: DatasourceProfile): string {
  return JSON.stringify([datasource.name, datasource.connectors, datasource.connection, datasource.resolverHints]);
}

export function runDatasourceConnectors(input: ConnectorRunInput): Promise<DoctorCheck[]> {
  if (input.mode === 'doctor') return runConnectors(input);
  const key = connectKey(input.datasource);
  const success = connectSuccesses.get(key);
  if (success && success.reusableUntil > Date.now()) return Promise.resolve(success.checks);
  const inFlight = connectsInFlight.get(key);
  if (inFlight) return inFlight;

  const run = runConnectors(input)
    .then((checks) => {
      if (checks.every((c) => c.status === DoctorStatus.Ok)) {
        connectSuccesses.set(key, { checks, reusableUntil: Date.now() + RUNTIME_CONSTANTS.connector.connectReuseMs });
      }
      return checks;
    })
    .finally(() => connectsInFlight.delete(key));
  connectsInFlight.set(key, run);
  return run;
}

async function runConnectors(input: ConnectorRunInput): Promise<DoctorCheck[]> {
  const connectors = input.datasource.connectors || [];
  const perCheckTimeoutMs =
    input.mode === 'connect'
      ? RUNTIME_CONSTANTS.connector.connectCheckTimeoutMs
      : RUNTIME_CONSTANTS.connector.statusCheckTimeoutMs;

  const settled = await Promise.allSettled(
    connectors.map(async (name): Promise<DoctorCheck[]> => {
      const plugin = input.pluginRegistry.get(name);
      if (!plugin) {
        return [{ check: `connector:${name}`, status: DoctorStatus.Warn, detail: 'connector plugin not found', code: 'connector_plugin_missing' }];
      }
      const refKey = `${name}CredentialRef`;
      const ref = str(input.datasource.resolverHints?.[refKey]).trim();
      const creds = ref ? await input.credentialStore.get(ref) : {};
      if (input.mode === 'doctor' && plugin.doctor) {
        return await withConnectorTimeout(name, 'doctor', perCheckTimeoutMs, () =>
          plugin.doctor!({ datasource: input.datasource, credentials: creds }),
        );
      }
      if (input.mode === 'connect' && plugin.connect) {
        return await withConnectorTimeout(name, 'connect', perCheckTimeoutMs, () =>
          plugin.connect!({ datasource: input.datasource, credentials: creds }),
        );
      }
      return [
        {
          check: `connector:${name}`,
          status: DoctorStatus.Warn,
          detail: `mode '${input.mode}' not supported by plugin`,
          code: 'connector_mode_unsupported',
        },
      ];
    }),
  );

  const checks: DoctorCheck[] = [];
  settled.forEach((result, idx) => {
    if (result.status === 'fulfilled') {
      checks.push(...result.value);
    } else {
      const name = connectors[idx];
      const message = (result.reason as Error)?.message || String(result.reason);
      checks.push({
        check: `connector:${name}`,
        status: DoctorStatus.Fail,
        detail: message.slice(0, 400),
        code: 'connector_check_failed',
      });
    }
  });
  return checks;
}
