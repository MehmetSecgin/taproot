import { createHash } from 'node:crypto';
import type { AppContext } from '../core/app.js';
import { TaprootError, classifyError } from '../core/error-classification.js';
import { withQueryTimeout } from '../core/query-timeout.js';
import type { DatasourceProfile } from '../types/core.js';

export type DatasourceCheck = (input: {
  ctx: AppContext;
  datasource: DatasourceProfile;
  credentials: Record<string, string>;
  timeoutMs: number;
}) => Promise<void>;

export type DatasourceGate = (datasource: DatasourceProfile, timeoutMs: number) => Promise<void>;

function namesItsClass(error: unknown): boolean {
  if (error instanceof TaprootError) return true;
  const systemError = error as { code?: unknown; message?: unknown };
  return typeof systemError?.code === 'string' && classifyError(String(systemError.message)) !== 'GENERIC';
}

function refusalError(error: unknown): unknown {
  if (namesItsClass(error)) return error;
  return new TaprootError('DATASOURCE_REFUSED', error instanceof Error ? error.message : String(error));
}

export function datasourceGate(ctx: AppContext, check: DatasourceCheck | undefined): DatasourceGate {
  if (!check) return async () => undefined;
  const passed = new Map<string, Promise<void>>();
  return async (datasource, timeoutMs) => {
    const credentials = await ctx.credentialStore.get(datasource.credentialRef);
    const key = createHash('sha256').update(JSON.stringify([datasource, credentials])).digest('hex');
    if (!passed.has(key)) {
      const checked = withQueryTimeout({ timeoutMs, signal: undefined, run: () => check({ ctx, datasource, credentials, timeoutMs }) });
      passed.set(key, checked.catch((error: unknown) => {
        passed.delete(key);
        throw refusalError(error);
      }));
    }
    await passed.get(key);
  };
}
