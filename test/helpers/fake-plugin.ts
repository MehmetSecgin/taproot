import type { QueryResult, TapRootPlugin } from '../../src/types/core.js';

export interface FakePluginOptions {
  kind?: string;
  holdMs?: number;
  columns?: string[];
  rows?: unknown[][];
  warnings?: string[];
  failWith?: string;
}

export function fakePlugin(options: FakePluginOptions = {}): TapRootPlugin {
  const kind = options.kind || 'fake';
  const columns = options.columns || ['ok'];
  const rows = options.rows || [[1]];
  return {
    manifest: {
      name: kind,
      capabilities: ['executeRead', 'executeMutate'],
    },
    connect: async () => [],
    execute: async (request): Promise<QueryResult> => {
      if (options.holdMs) await new Promise((resolve) => setTimeout(resolve, options.holdMs));
      if (options.failWith) throw new Error(options.failWith);
      const startedAt = new Date().toISOString();
      return {
        datasource: request.datasource.name,
        plugin: kind,
        capability: request.capability,
        query: { native: request.query },
        result: { columns, rows },
        timings: { startedAt, endedAt: startedAt, durationMs: 1 },
        warnings: options.warnings ? [...options.warnings] : [],
        classification: 'success',
      };
    },
  };
}
