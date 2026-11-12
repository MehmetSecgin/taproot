import path from 'node:path';
import { RUNTIME_CONSTANTS } from './constants.js';
import { ensurePaths, resolveFallbackPaths, resolvePaths } from './paths.js';
import { DatasourceStore } from '../store/datasources.js';
import { CredentialStore } from '../store/credentials.js';
import { KbStore } from '../store/kb.js';
import { SchemaCatalogStore } from '../store/schema-catalog.js';
import { RuntimeConfigStore } from '../store/runtime-config.js';
import { builtinPlugins, type PluginRegistry } from '../plugins/load-builtins.js';
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
  return {
    paths,
    datasourceStore: new DatasourceStore(paths.datasourceFile),
    credentialStore: new CredentialStore(paths.credentialFile),
    kbStore: new KbStore(paths.kbDir),
    schemaCatalogStore: new SchemaCatalogStore(path.join(paths.cacheDir, 'schema')),
    runtimeConfigStore: new RuntimeConfigStore(paths.runtimeConfigFile),
    pluginRegistry: builtinPlugins(),
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

export function defaultDatasourceName(env: string, service: string, namespace?: string): string {
  const normalizedNamespace = normalizeNamespace(namespace);
  return normalizedNamespace ? `${env}-${normalizedNamespace}-${service}` : `${env}-${service}`;
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

interface ConnectorRunInput {
  datasource: DatasourceProfile;
  credentialStore: { get: (ref: string) => Promise<Record<string, string>> };
  pluginRegistry: PluginRegistry;
  mode: 'doctor' | 'connect';
}

const recentConnects = new Map<string, { checks: Promise<DoctorCheck[]>; expiresAt: number }>();

export function runDatasourceConnectors(input: ConnectorRunInput): Promise<DoctorCheck[]> {
  if (input.mode === 'doctor') return runConnectors(input);
  const name = input.datasource.name;
  const recent = recentConnects.get(name);
  if (recent && recent.expiresAt > Date.now()) return recent.checks;

  const run = { checks: runConnectors(input), expiresAt: Number.POSITIVE_INFINITY };
  recentConnects.set(name, run);
  void run.checks.then((checks) => {
    if (checks.every((c) => c.status === DoctorStatus.Ok)) {
      run.expiresAt = Date.now() + RUNTIME_CONSTANTS.connector.connectReuseMs;
    } else if (recentConnects.get(name) === run) {
      recentConnects.delete(name);
    }
  });
  return run.checks;
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
