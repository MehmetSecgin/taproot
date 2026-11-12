import path from 'node:path';
import { ensurePaths, resolveFallbackPaths, resolvePaths } from './paths.js';
import { DatasourceStore } from '../store/datasources.js';
import { CredentialStore } from '../store/credentials.js';
import { KbStore } from '../store/kb.js';
import { SchemaCatalogStore } from '../store/schema-catalog.js';
import { RuntimeConfigStore } from '../store/runtime-config.js';
import { builtinPlugins, type PluginRegistry } from '../plugins/load-builtins.js';
import type { EnvironmentPolicy } from '../types/core.js';

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

export function environmentPolicy(ctx: Pick<AppContext, 'runtimeConfigStore'>, env?: string): EnvironmentPolicy {
  return ctx.runtimeConfigStore.environmentPolicy(env);
}
