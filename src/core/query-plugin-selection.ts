import type { AppContext } from './app.js';
import type { DatasourceProfile } from '../types/datasource.js';
import type { QueryRequest, TapRootPlugin } from '../types/plugin.js';

type PluginSelection = { pluginName: string; execute: NonNullable<TapRootPlugin['execute']> } | { refusal: string };

export function selectPlugin(ctx: AppContext, datasource: DatasourceProfile, capability: QueryRequest['capability']): PluginSelection {
  const plugin = ctx.pluginRegistry.get(datasource.kind);
  if (!plugin?.execute) {
    return { refusal: `No execute-capable plugin for datasource kind '${datasource.kind}'.` };
  }
  if (!plugin.manifest.capabilities.includes(capability)) {
    return { refusal: `Plugin '${plugin.manifest.name}' does not support capability ${capability}.` };
  }
  return { pluginName: plugin.manifest.name, execute: plugin.execute };
}

