import type { QueryRequest, QueryResult, TapRootPlugin } from '../../src/types/plugin.js';
import { waitMs } from '../../src/core/wait.js';

export type FakePluginOptions = {
  kind?: string;
  holdMs?: number;
  columns?: string[];
  rows?: unknown[][];
  warnings?: string[];
  failWith?: string;
};

export function fakePlugin(options: FakePluginOptions = {}): TapRootPlugin {
  const kind = options.kind ?? 'fake';
  const columns = options.columns ?? ['ok'];
  const rows = options.rows ?? [[1]];
  return {
    manifest: {
      name: kind,
      capabilities: ['executeRead', 'executeMutate'],
    },
    connect: async () => [],
    execute: async (request): Promise<QueryResult> => {
      if (options.holdMs !== undefined && options.holdMs !== 0) {
        await waitMs(options.holdMs);
      }
      if (options.failWith !== undefined && options.failWith !== '') {
        throw new Error(options.failWith);
      }
      const startedAt = new Date().toISOString();
      return {
        datasource: request.datasource.name,
        plugin: kind,
        capability: request.capability,
        query: { native: request.query },
        result: { columns, rows },
        timings: { startedAt, endedAt: startedAt, durationMs: 1 },
        warnings: options.warnings === undefined ? [] : [...options.warnings],
        classification: 'success',
      };
    },
  };
}

type ExecutePlugin = NonNullable<TapRootPlugin['execute']>;

export function wrapExecute(plugin: TapRootPlugin, wrap: (inner: ExecutePlugin) => ExecutePlugin): TapRootPlugin {
  const { execute } = plugin;
  if (execute === undefined) {
    throw new Error('plugin has no execute');
  }
  return { ...plugin, execute: wrap(execute) };
}

export function interceptExecute(plugin: TapRootPlugin, intercept: (request: QueryRequest, credentials: Record<string, string>) => void): TapRootPlugin {
  return wrapExecute(plugin, (inner) => async (request, credentials) => {
    intercept(request, credentials);
    return inner(request, credentials);
  });
}
