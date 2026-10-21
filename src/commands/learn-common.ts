import type { AppContext } from '../core/app.js';
import { normalizeNamespace, normalizeService } from '../core/app.js';
import { bootstrapDatasource } from '../core/bootstrap.js';
import { supportsSchemaRefresh } from '../core/schema-refresh.js';
import { str } from '../core/strings.js';
import type { DatasourceProfile } from '../types/core.js';

export interface LearnTargetOpts {
  datasource?: string;
  env?: string;
  namespace?: string;
  service?: string;
}

export async function resolveDatasource(ctx: AppContext, opts: LearnTargetOpts): Promise<DatasourceProfile | undefined> {
  if (opts.datasource) return ctx.datasourceStore.get(String(opts.datasource));
  const env = str(opts.env).trim();
  const namespace = normalizeNamespace(str(opts.namespace));
  const service = normalizeService(str(opts.service), ctx.runtimeConfigStore.serviceAliases());
  if (!env || !service) return undefined;
  const ds = ctx.datasourceStore.resolveByEnvService(env, service, namespace || undefined);
  if (ds) return ds;
  const bootstrapped = await bootstrapDatasource(ctx, env, service, `${env}-${service}`, namespace || undefined);
  return bootstrapped?.profile;
}

export function isTargetedRequest(opts: LearnTargetOpts): boolean {
  return Boolean(opts.datasource || opts.env || opts.namespace || opts.service);
}

export function unresolvedNextCommand(opts: LearnTargetOpts, ctx?: AppContext): string | null {
  const datasource = str(opts.datasource).trim();
  if (datasource) return `taproot --json datasource show ${datasource}`;
  const env = str(opts.env).trim();
  const namespace = normalizeNamespace(str(opts.namespace));
  const service = str(opts.service).trim();
  if (!env || !service) return null;
  if (ctx) {
    const candidates = ctx.datasourceStore.candidatesByService(service);
    if (candidates.length) {
      const tagged = candidates.map((d) => `${d.name} (env=${d.env}${d.namespace ? ` ns=${d.namespace}` : ''})`).slice(0, 4).join(', ');
      const first = candidates[0];
      return `taproot --json learn ensure-schema --datasource ${first.name}  # available: ${tagged}`;
    }
  }
  return `taproot --json init datasource --env ${env}${namespace ? ` --namespace ${namespace}` : ''} --service ${service}`;
}

export function scopedRows<T>(input: { datasource?: DatasourceProfile; targeted: boolean; load: (key?: string) => T[]; keyKind?: 'service' | 'datasource' }): T[] {
  if (input.datasource) {
    const kind = input.keyKind || 'service';
    const key = kind === 'service' ? str(input.datasource.service) : input.datasource.name;
    return input.load(key || undefined);
  }
  if (input.targeted) return [];
  return input.load(undefined);
}

export function emptyState(input: {
  datasource?: DatasourceProfile;
  rows: unknown[];
  kind: 'tables' | 'joins';
  unresolved?: boolean;
  suggestedNextCommand?: string | null;
}): { emptyReason: string | null; suggestedNextCommand: string | null } {
  if (input.rows.length) return { emptyReason: null, suggestedNextCommand: null };
  if (input.unresolved) return { emptyReason: 'datasource_unresolved', suggestedNextCommand: input.suggestedNextCommand || null };
  if (!input.datasource) return { emptyReason: 'no_learning_yet', suggestedNextCommand: null };
  if (!supportsSchemaRefresh(input.datasource)) {
    return { emptyReason: 'learning_unsupported', suggestedNextCommand: null };
  }
  return {
    emptyReason: 'schema_refresh_required',
    suggestedNextCommand: `taproot --json learn refresh-schema --datasource ${input.datasource.name}`,
  };
}

export function printEmptyState(kind: 'tables' | 'joins', state: { emptyReason: string | null; suggestedNextCommand: string | null }): void {
  if (!state.emptyReason) return;
  console.log(`No learned schema ${kind} found (${state.emptyReason}).`);
  if (state.suggestedNextCommand) console.log(`next: ${state.suggestedNextCommand}`);
}
