import path from 'node:path';
import { RUNTIME_CONSTANTS } from './constants.js';
import { ensurePaths, resolveFallbackPaths, resolvePaths } from './paths.js';
import { DatasourceStore } from '../store/datasources.js';
import { CredentialStore } from '../store/credentials.js';
import { KbStore } from '../store/kb.js';
import { SchemaCatalogStore } from '../store/schema-catalog.js';
import { RuntimeConfigStore } from '../store/runtime-config.js';
import { PluginRegistry } from '../plugins/registry.js';
import { loadBuiltins } from '../plugins/load-builtins.js';
import { DoctorStatus } from '../types/core.js';
import type { DatasourceProfile, DoctorCheck, EnvironmentPolicy } from '../types/core.js';
import { str } from './strings.js';
import { badInput } from './error-classification.js';
export { classifyError } from './error-classification.js';

export interface AppContext {
  paths: ReturnType<typeof resolvePaths>;
  datasourceStore: DatasourceStore;
  credentialStore: CredentialStore;
  kbStore: KbStore;
  schemaCatalogStore: SchemaCatalogStore;
  runtimeConfigStore: RuntimeConfigStore;
  pluginRegistry: PluginRegistry;
  verbose: boolean;
}

export function buildContext(opts: {
  kbDir?: string;
  verbose?: boolean;
}): AppContext {
  let paths = resolvePaths(opts.kbDir);
  try {
    ensurePaths(paths);
  } catch {
    paths = resolveFallbackPaths(opts.kbDir);
    ensurePaths(paths);
  }
  const pluginRegistry = new PluginRegistry();
  const runtimeConfigStore = new RuntimeConfigStore(paths.runtimeConfigFile);
  loadBuiltins(pluginRegistry);
  return {
    paths,
    datasourceStore: new DatasourceStore(paths.datasourceFile),
    credentialStore: new CredentialStore(paths.credentialFile),
    kbStore: new KbStore(paths.kbDir),
    schemaCatalogStore: new SchemaCatalogStore(path.join(paths.cacheDir, 'schema')),
    runtimeConfigStore,
    pluginRegistry,
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

export function parseParamPairs(values: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values) {
    const idx = value.indexOf('=');
    if (idx <= 0) throw badInput(`Invalid --param '${value}'. Expected key=value.`);
    const key = value.slice(0, idx).trim();
    const val = value.slice(idx + 1);
    out[key] = val;
  }
  return out;
}

export function nextAction(errorCode: string): string {
  const mapping: Record<string, string> = {
    BAD_INPUT: 'Fix the request payload to match the proto schema, or pass --skip-proto-validate to bypass local validation.',
    QUERY_TIMEOUT: 'Retry with a narrower query or raise --timeout if the longer runtime is intentional.',
    MISSING_PARTITION_PREDICATE: 'Add the table partition column to WHERE or JOIN predicates and retry through TapRoot.',
    MISCONFIGURED_DATASOURCE: 'Repair or recreate the datasource profile so it matches KB-backed routing before retrying.',
    ACCESS_DENIED: 'Check datasource credentialRef and credential values.',
    UNKNOWN_DATABASE: 'Resolve canonical database name via datasource/kb resolve.',
    UNKNOWN_TARGET: 'Verify host/target in datasource profile and connector module.',
    CONNECTIVITY: "The endpoint is unreachable or cluster DNS is not resolving its hostname. Check the cluster network connection (VPN, telepresence or port-forward), then run 'taproot doctor'.",
    AUTH_EXPIRED: 'Refresh credentials/session and retry.',
    OVERLOADED: 'Retry shortly; daemon query queue is saturated.',
    SESSION_BUSY: 'Wait for in-flight queries on this datasource session to finish, then retry.',
    DETERMINISTIC_REQUIRED: 'Provide --datasource or --env+--service with KB/profile-backed resolution, or enable discovery explicitly for that environment.',
    DISCOVERY_UNAVAILABLE: 'Populate the datasource store or KB with deterministic routing data before retrying.',
    KB_MISSING: 'Point TapRoot at the KB directory with "taproot init --kb-dir <dir>" (saved in TapRoot config), or register the datasource with "taproot datasource add".',
    AMBIGUOUS_DB_USER: 'Ask the user which of the listed db users this datasource should use, then save it with the creds set or --hint dbUser= command in the message.',
    UNKNOWN_DATASOURCE: 'Use a datasource name suggested in the message, or pass --env and --service instead. List profiles with "taproot datasource list".',
    UNKNOWN_COLUMN: 'Check column names against meta.schemaContext.tables (or SHOW COLUMNS FROM <table>), fix the query, then retry.',
    UNKNOWN_TABLE: 'Check table names with SHOW TABLES, then fix the query.',
    SQL_SYNTAX: 'Fix the SQL syntax near the position the error names. The same SQL fails the same way, so do not retry it unchanged.',
    GENERIC: 'Read the error message; verify datasource resolution (--datasource or --env+--service) and query syntax, then retry.',
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
        status: DoctorStatus.Fail,
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
      if (input.mode === 'disconnect' && plugin.disconnect) {
        return await withConnectorTimeout(name, 'disconnect', perCheckTimeoutMs, () =>
          plugin.disconnect!({ datasource: input.datasource, credentials: creds }),
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
