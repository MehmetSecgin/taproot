import type { AppContext } from '../core/app.js';
import { parseKeyValuePairs } from '../core/key-value.js';
import { normalizeNamespace, normalizeService } from '../core/naming.js';
import { nowIso } from '../core/time.js';
import type { Capability, DatasourceProfile } from '../types/datasource.js';
import { emptyToUndefined, firstNonEmpty } from '../core/text-presence.js';
import { badInput } from '../core/taproot-error.js';
import { hasDatabase } from '../core/has-database.js';
import { parseDatasourceProfile } from '../store/schemas.js';

export type DatasourceAddOptions = {
  name: string;
  kind: string;
  credentialRef?: string;
  env?: string;
  namespace?: string;
  service?: string;
  host?: string;
  port?: string;
  database?: string;
  target?: string;
  ssl: boolean;
  connector: string[];
  connectorRef: string[];
  hint: string[];
  teleportRef?: string;
  allowRead: boolean;
  allowMutate: boolean;
  strictKeyspace: boolean;
  requireDatabase: boolean;
  probe: boolean;
};

function connectorCredentialRefHints(values: string[]): Record<string, string> {
  const refs = Object.entries(parseKeyValuePairs('--connector-ref', values));
  return Object.fromEntries(refs.map(([connector, ref]) => [`${connector}CredentialRef`, ref.trim()]));
}

function profileFromAddOptions(ctx: AppContext, opts: DatasourceAddOptions, credentialRef: string): Record<string, unknown> {
  const namespace = emptyToUndefined(opts.namespace);
  const service = emptyToUndefined(opts.service);
  const port = emptyToUndefined(opts.port);
  const allowedCapabilities: Capability[] = opts.allowMutate ? ['executeRead', 'executeMutate'] : ['executeRead'];
  return {
    name: opts.name,
    kind: opts.kind,
    env: opts.env,
    namespace: namespace === undefined ? undefined : normalizeNamespace(namespace),
    service: service === undefined ? undefined : normalizeService(service, ctx.runtimeConfigStore.serviceAliases()),
    tags: [],
    connection: {
      host: opts.host,
      port: port === undefined ? undefined : Number(port),
      database: opts.database,
      target: opts.target,
      ssl: opts.ssl,
    },
    credentialRef,
    connectors: opts.connector,
    policy: {
      allowRead: opts.allowRead,
      allowMutate: opts.allowMutate,
      allowedCapabilities,
      ...(opts.requireDatabase ? { requireDatabase: true } : {}),
      ...(opts.strictKeyspace ? { strictKeyspace: true } : {}),
    },
    resolverHints: {
      ...connectorCredentialRefHints(opts.connectorRef),
      ...parseKeyValuePairs('--hint', opts.hint),
      ...(emptyToUndefined(opts.teleportRef) === undefined ? {} : { teleportCredentialRef: opts.teleportRef }),
    },
    updatedAt: nowIso(),
  };
}

export function validatedProfileFromOptions(ctx: AppContext, opts: DatasourceAddOptions): DatasourceProfile {
  if (opts.requireDatabase && !hasDatabase(opts.database)) {
    throw badInput('--require-database needs --database <n>; without it every query on this datasource would fail.');
  }
  const credentialRef = firstNonEmpty(opts.credentialRef, opts.env);
  if (credentialRef === undefined) {
    throw badInput('datasource add needs --env or --credential-ref; the credential ref defaults to --env.');
  }
  const validated = parseDatasourceProfile(profileFromAddOptions(ctx, opts, credentialRef));
  if (!validated.ok) {
    throw badInput(`Invalid datasource ${opts.name}: ${validated.error}`);
  }
  return validated.profile;
}
