import { createHash } from 'node:crypto';
import type { AppContext } from '../core/app.js';
import { TaprootError, classifyError } from '../core/error-classification.js';
import type { DatasourceProfile } from '../types/core.js';

export type DatasourceCheck = (input: {
  ctx: AppContext;
  datasource: DatasourceProfile;
  credentials: Record<string, string>;
  timeoutMs: number;
}) => Promise<void>;

export type DatasourceGate = (datasource: DatasourceProfile, timeoutMs: number) => Promise<void>;

function refusalError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  return classifyError(message) === 'GENERIC' ? new TaprootError('DATASOURCE_REFUSED', message) : error;
}

export function datasourceGate(ctx: AppContext, check: DatasourceCheck | undefined): DatasourceGate {
  if (!check) return async () => undefined;
  const passed = new Map<string, Promise<void>>();
  return async (datasource, timeoutMs) => {
    const credentials = await ctx.credentialStore.get(datasource.credentialRef);
    const key = createHash('sha256').update(JSON.stringify([datasource, credentials])).digest('hex');
    if (!passed.has(key)) {
      passed.set(key, check({ ctx, datasource, credentials, timeoutMs }).catch((error: unknown) => {
        passed.delete(key);
        throw refusalError(error);
      }));
    }
    await passed.get(key);
  };
}
