import path from 'node:path';
import { RUNTIME_CONSTANTS } from './constants.js';
import { ensurePaths, resolveFallbackPaths, resolvePaths } from './paths.js';
import { DatasourceStore } from '../store/datasources.js';
import { TemplateStore } from '../store/templates.js';
import { CredentialStore } from '../store/credentials.js';
import { KbStore } from '../store/kb.js';
import { LearningStore } from '../store/learning.js';
import { RuntimeConfigStore } from '../store/runtime-config.js';
import { CardStore } from '../store/cards.js';
import { PluginRegistry } from '../plugins/registry.js';
import { loadBuiltins } from '../plugins/load-builtins.js';
import type { DatasourceProfile, DoctorCheck, EnvironmentPolicy } from '../types/core.js';
export { classifyError } from './error-classification.js';

export interface AppContext {
  paths: ReturnType<typeof resolvePaths>;
  datasourceStore: DatasourceStore;
  templateStore: TemplateStore;
  credentialStore: CredentialStore;
  kbStore: KbStore;
  learningStore: LearningStore;
  runtimeConfigStore: RuntimeConfigStore;
  cardStore: CardStore;
  pluginRegistry: PluginRegistry;
  jsonMode: boolean;
  noColor: boolean;
  noAnimations: boolean;
  verbose: boolean;
}

export function buildContext(opts: {
  memoryRoot?: string;
  jsonMode?: boolean;
  noColor?: boolean;
  noAnimations?: boolean;
  verbose?: boolean;
}): AppContext {
  let paths = resolvePaths(opts.memoryRoot);
  try {
    ensurePaths(paths);
  } catch {
    paths = resolveFallbackPaths(opts.memoryRoot);
    ensurePaths(paths);
  }
  const pluginRegistry = new PluginRegistry();
  const runtimeConfigStore = new RuntimeConfigStore(paths.runtimeConfigFile);
  loadBuiltins(pluginRegistry);
  return {
    paths,
    datasourceStore: new DatasourceStore(paths.datasourceFile),
    templateStore: new TemplateStore(paths.templatesFile),
    credentialStore: new CredentialStore(paths.credentialFile),
    kbStore: new KbStore(paths.kbDir),
    learningStore: new LearningStore(paths.learningDir),
    runtimeConfigStore,
    cardStore: new CardStore({ stateRoot: paths.stateRoot, runtimeConfigStore }),
    pluginRegistry,
    jsonMode: Boolean(opts.jsonMode),
    noColor: Boolean(opts.noColor),
    noAnimations: Boolean(opts.noAnimations),
    verbose: Boolean(opts.verbose),
  };
}

export function normalizeService(value?: string, aliases?: Record<string, string>): string {
  const v = (value || '').trim();
  if (!v) return '';
  const normalized = v.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').replace(/\s+/g, '-').toLowerCase();
  const aliasMap = aliases || {};
  return aliasMap[normalized] || normalized;
}

export function normalizeNamespace(value?: string): string {
  return (value || '').trim().replace(/_/g, '-').replace(/\s+/g, '-').toLowerCase();
}

export function environmentPolicy(ctx: Pick<AppContext, 'runtimeConfigStore'>, env?: string): EnvironmentPolicy {
  return ctx.runtimeConfigStore.environmentPolicy(env);
}

export function fillTemplate(template: string, params: Record<string, string>): string {
  return template.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, key: string) => {
    if (!(key in params)) throw new Error(`Missing --param for :${key}`);
    const value = params[key];
    if (/^[-+]?\d+(\.\d+)?$/.test(value)) return value;
    return `'${value.replace(/'/g, "''")}'`;
  });
}

export function parseParamPairs(values: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values) {
    const idx = value.indexOf('=');
    if (idx <= 0) throw new Error(`Invalid --param '${value}'. Expected key=value.`);
    const key = value.slice(0, idx).trim();
    const val = value.slice(idx + 1);
    out[key] = val;
  }
  return out;
}

export function nextAction(errorCode: string): string {
  const mapping: Record<string, string> = {
    QUERY_TIMEOUT: 'Retry with a narrower query or raise --timeout-ms if the longer runtime is intentional.',
    MISSING_PARTITION_PREDICATE: 'Add the table partition column to WHERE or JOIN predicates and retry through TapRoot.',
    REDUNDANT_INTROSPECTION: 'Read the cached schema with "taproot --json learn ensure-schema --service <svc>" instead of re-issuing SHOW CREATE/DESCRIBE/SHOW COLUMNS. Pass --allow-schema-introspection to force re-introspection.',
    MISCONFIGURED_DATASOURCE: 'Repair or recreate the datasource profile so it matches KB-backed routing before retrying.',
    ACCESS_DENIED: 'Check datasource credentialRef and credential values.',
    UNKNOWN_DATABASE: 'Resolve canonical database name via datasource/kb resolve.',
    UNKNOWN_TARGET: 'Verify host/target in datasource profile and connector module.',
    CONNECTIVITY: 'Check VPN/network and endpoint reachability.',
    AUTH_EXPIRED: 'Refresh credentials/session and retry.',
    OVERLOADED: 'Retry shortly; daemon query queue is saturated.',
    SESSION_BUSY: 'Wait for in-flight queries on this datasource session to finish, then retry.',
    DETERMINISTIC_REQUIRED: 'Provide --datasource or --env+--service with KB/profile-backed resolution, or enable discovery explicitly for that environment.',
    DISCOVERY_UNAVAILABLE: 'Populate datasource store, KB, or TapRoot learning with deterministic routing data before retrying.',
    GENERIC: 'Inspect error details and rerun with --json for envelope details.',
  };
  return mapping[errorCode] || mapping.GENERIC;
}

export function defaultDatasourceName(env: string, service: string, namespace?: string): string {
  const normalizedNamespace = normalizeNamespace(namespace);
  return normalizedNamespace ? `${env}-${normalizedNamespace}-${service}` : `${env}-${service}`;
}

export function runOutputDir(paths: ReturnType<typeof resolvePaths>): string {
  return path.join(paths.stateRoot, 'runs');
}

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
        status: 'fail',
        detail: message.slice(0, 400),
        code: message.startsWith('connector_timeout') ? 'connector_timeout' : 'connector_check_failed',
      },
    ];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runDatasourceConnectors(input: {
  datasource: DatasourceProfile;
  credentialStore: { get: (ref: string) => Promise<Record<string, string>> };
  pluginRegistry: PluginRegistry;
  mode: 'doctor' | 'connect' | 'disconnect';
}): Promise<DoctorCheck[]> {
  const connectors = input.datasource.connectors || [];
  const perCheckTimeoutMs =
    input.mode === 'connect'
      ? RUNTIME_CONSTANTS.connector.connectCheckTimeoutMs
      : RUNTIME_CONSTANTS.connector.statusCheckTimeoutMs;

  const settled = await Promise.allSettled(
    connectors.map(async (name): Promise<DoctorCheck[]> => {
      const plugin = input.pluginRegistry.get(name);
      if (!plugin) {
        return [{ check: `connector:${name}`, status: 'warn', detail: 'connector plugin not found', code: 'connector_plugin_missing' }];
      }
      const refKey = `${name}CredentialRef`;
      const ref = String(input.datasource.resolverHints?.[refKey] || '').trim();
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
      if (input.mode === 'disconnect' && plugin.disconnect) {
        return await withConnectorTimeout(name, 'disconnect', perCheckTimeoutMs, () =>
          plugin.disconnect!({ datasource: input.datasource, credentials: creds }),
        );
      }
      return [
        {
          check: `connector:${name}`,
          status: 'warn',
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
        status: 'fail',
        detail: message.slice(0, 400),
        code: 'connector_check_failed',
      });
    }
  });
  return checks;
}
