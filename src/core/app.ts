import path from 'node:path';
import { ensurePaths, resolveFallbackPaths, resolvePaths } from './paths.js';
import { DatasourceStore } from '../store/datasources.js';
import { TemplateStore } from '../store/templates.js';
import { CredentialStore } from '../store/credentials.js';
import { KbStore } from '../store/kb.js';
import { LearningStore } from '../store/learning.js';
import { RuntimeConfigStore } from '../store/runtime-config.js';
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
  loadBuiltins(pluginRegistry);
  return {
    paths,
    datasourceStore: new DatasourceStore(paths.datasourceFile),
    templateStore: new TemplateStore(paths.templatesFile),
    credentialStore: new CredentialStore(paths.credentialFile),
    kbStore: new KbStore(paths.kbDir),
    learningStore: new LearningStore(paths.learningDir),
    runtimeConfigStore: new RuntimeConfigStore(paths.runtimeConfigFile),
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

export function defaultDatasourceName(env: string, service: string): string {
  return `${env}-${service}`;
}

export function runOutputDir(paths: ReturnType<typeof resolvePaths>): string {
  return path.join(paths.stateRoot, 'runs');
}

export async function runDatasourceConnectors(input: {
  datasource: DatasourceProfile;
  credentialStore: { get: (ref: string) => Promise<Record<string, string>> };
  pluginRegistry: PluginRegistry;
  mode: 'doctor' | 'connect' | 'disconnect';
}): Promise<DoctorCheck[]> {
  const connectors = input.datasource.connectors || [];
  const checks: DoctorCheck[] = [];
  for (const name of connectors) {
    const plugin = input.pluginRegistry.get(name);
    if (!plugin) {
      checks.push({ check: `connector:${name}`, status: 'warn', detail: 'connector plugin not found', code: 'connector_plugin_missing' });
      continue;
    }
    const refKey = `${name}CredentialRef`;
    const ref = String(input.datasource.resolverHints?.[refKey] || '').trim();
    const creds = ref ? await input.credentialStore.get(ref) : {};
    if (input.mode === 'doctor' && plugin.doctor) {
      checks.push(...(await plugin.doctor({ datasource: input.datasource, credentials: creds })));
    } else if (input.mode === 'connect' && plugin.connect) {
      checks.push(...(await plugin.connect({ datasource: input.datasource, credentials: creds })));
    } else if (input.mode === 'disconnect' && plugin.disconnect) {
      checks.push(...(await plugin.disconnect({ datasource: input.datasource, credentials: creds })));
    } else {
      checks.push({
        check: `connector:${name}`,
        status: 'warn',
        detail: `mode '${input.mode}' not supported by plugin`,
        code: 'connector_mode_unsupported',
      });
    }
  }
  return checks;
}
