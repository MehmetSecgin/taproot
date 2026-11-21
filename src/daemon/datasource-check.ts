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
  signal: AbortSignal;
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

interface CheckEntry {
  checked: Promise<void>;
  expiresAt: number;
}

export function datasourceGate(ctx: AppContext, check: DatasourceCheck | undefined, ttlMs: number | undefined): DatasourceGate {
  if (!check) return async () => undefined;
  const entries = new Map<string, CheckEntry>();
  const startCheck = (key: string, datasource: DatasourceProfile, credentials: Record<string, string>, timeoutMs: number): CheckEntry => {
    const entry: CheckEntry = { checked: Promise.resolve(), expiresAt: Infinity };
    entry.checked = withQueryTimeout({ timeoutMs, signal: undefined, run: (signal) => check({ ctx, datasource, credentials, timeoutMs, signal }) }).then(
      () => {
        entry.expiresAt = Date.now() + (ttlMs ?? Infinity);
      },
      (error: unknown) => {
        entries.delete(key);
        throw refusalError(error);
      },
    );
    entries.set(key, entry);
    return entry;
  };
  return async (datasource, timeoutMs) => {
    const credentials = await ctx.credentialStore.get(datasource.credentialRef);
    const key = createHash('sha256').update(JSON.stringify([datasource, credentials])).digest('hex');
    const known = entries.get(key);
    const entry = known && Date.now() < known.expiresAt ? known : startCheck(key, datasource, credentials, timeoutMs);
    await entry.checked;
  };
}
