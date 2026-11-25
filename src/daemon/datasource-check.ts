import { createHash } from 'node:crypto';
import type { AppContext } from '../core/app.js';
import { classifyError } from '../core/error-classification.js';
import { TaprootError } from '../core/taproot-error.js';
import { withQueryTimeout } from '../core/query-timeout.js';
import type { DatasourceProfile } from '../types/datasource.js';
import { errorText } from '../core/error-text.js';

export type DatasourceCheck = (input: {
  ctx: AppContext;
  datasource: DatasourceProfile;
  credentials: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
}) => Promise<void>;

export type DatasourceGate = (datasource: DatasourceProfile, timeoutMs: number) => Promise<void>;

type CheckRequest = { datasource: DatasourceProfile; credentials: Record<string, string>; timeoutMs: number };

type SystemErrorShape = { code?: unknown; message?: unknown };

function isAlreadyClassified(error: unknown): boolean {
  if (error instanceof TaprootError) {
    return true;
  }
  const systemError: SystemErrorShape | null | undefined = typeof error === 'object' ? error : undefined;
  return typeof systemError?.code === 'string' && classifyError(String(systemError.message)) !== 'GENERIC';
}

function asDatasourceRefusal(error: unknown): unknown {
  if (isAlreadyClassified(error)) {
    return error;
  }
  return new TaprootError('DATASOURCE_REFUSED', errorText(error));
}

export function datasourceGate(ctx: AppContext, check: DatasourceCheck | undefined, ttlMs: number | undefined): DatasourceGate {
  if (check === undefined) {
    return async () => {
      await Promise.resolve();
    };
  }
  const pendingChecks = new Map<string, Promise<void>>();
  const passedAt = new Map<string, number>();
  const isExpired = (key: string): boolean => Date.now() - (passedAt.get(key) ?? Infinity) >= (ttlMs ?? Infinity);

  const runCheck = async (key: string, request: CheckRequest): Promise<void> => {
    try {
      await withQueryTimeout({ timeoutMs: request.timeoutMs, signal: undefined, run: async (signal) => check({ ctx, ...request, signal }) });
    } catch (error) {
      pendingChecks.delete(key);
      throw asDatasourceRefusal(error);
    }
    passedAt.set(key, Date.now());
  };

  return async (datasource, timeoutMs) => {
    const credentials = await ctx.credentialStore.get(datasource.credentialRef);
    const key = createHash('sha256').update(JSON.stringify([datasource, credentials])).digest('hex');
    if (isExpired(key)) {
      pendingChecks.delete(key);
      passedAt.delete(key);
    }
    let pending = pendingChecks.get(key);
    if (pending === undefined) {
      pending = runCheck(key, { datasource, credentials, timeoutMs });
      pendingChecks.set(key, pending);
    }
    await pending;
  };
}
