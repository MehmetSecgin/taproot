import type { QueryResult, TapRootPlugin } from '../../types/plugin.js';
import { nowIso } from '../../core/time.js';
import { pingRedis } from './doctor.js';
import { queryRedis } from './query.js';


export const redisPlugin: TapRootPlugin = {
  manifest: {
    name: 'redis',
    capabilities: ['doctor', 'executeRead', 'executeMutate'],
  },

  doctor: pingRedis,

  async execute(request, creds): Promise<QueryResult> {
    const startedAt = nowIso();
    const start = Date.now();
    const { rows, warnings } = await queryRedis(request, creds);
    return {
      datasource: request.datasource.name,
      plugin: 'redis',
      capability: request.capability,
      query: { native: request.query },
      result: { columns: ['value'], rows },
      timings: {
        startedAt,
        endedAt: nowIso(),
        durationMs: Date.now() - start,
      },
      warnings,
      classification: 'success',
    };
  },
};
