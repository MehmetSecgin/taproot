import type { AppContext } from '../core/app.js';
import { reconcileDatasource } from '../core/bootstrap.js';
import { normalizeNamespace, normalizeService } from '../core/naming.js';
import { printSuccess } from '../core/output.js';
import { describeTarget } from '../core/describe-target.js';
import { emptyToUndefined } from '../core/text-presence.js';

export type InitDatasourceOptions = { env: string; namespace?: string; service: string };

export async function initDatasource(ctx: AppContext, opts: InitDatasourceOptions): Promise<void> {
  ctx.kbStore.requirePresent();
  const service = normalizeService(opts.service, ctx.runtimeConfigStore.serviceAliases());
  const namespace = emptyToUndefined(normalizeNamespace(opts.namespace));
  const result = await reconcileDatasource(ctx, { env: opts.env, service, namespace });
  if (!result) {
    throw new Error(`No KB data found for ${describeTarget({ env: opts.env, namespace, service })}`);
  }
  printSuccess({ source: result.source, profile: result.profile, credentialRefs: result.credentialRefs });
}
