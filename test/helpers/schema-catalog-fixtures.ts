import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildContext } from '../../src/core/app.js';
import type { AppContext } from '../../src/core/app.js';
import type { QuerySlot } from '../../src/core/schema-refresh.js';
import { CredentialStore } from '../../src/store/credentials.js';
import type { DatasourceProfile } from '../../src/types/datasource.js';
import type { TapRootPlugin } from '../../src/types/plugin.js';

export type Rows = Record<string, unknown>[];

type InformationSchemaRows = { columns?: Rows; statistics?: Rows; partitions?: Rows };

class FixedCredentialStore extends CredentialStore {
  private readonly fixedCredentials = { user: 'reader', password: 'secret' };

  public override async get(): Promise<Record<string, string>> {
    return this.fixedCredentials;
  }
}

const SESSION_CREDENTIAL_KEY = '__sessionId';

export const ROUTINE = { sessionId: undefined, acquireQuerySlot: undefined, afterSchemaError: false };
export const AFTER_SCHEMA_ERROR = { sessionId: undefined, acquireQuerySlot: undefined, afterSchemaError: true };

export const ORDERS_COLUMNS: Rows = [
  { table_name: 'orders', column_name: 'id' },
  { table_name: 'orders', column_name: 'order_date' },
  { table_name: 'customers', column_name: 'id' },
  { table_name: 'shipments', column_name: 'id' },
];

export const slotStats = { released: 0 };

function releaseSlot(): void {
  slotStats.released += 1;
}

export const immediateQuerySlot: QuerySlot = async () => releaseSlot;

export function columnRowsOnly(currentColumns: () => Rows): (sql: string) => Rows {
  return (sql) => (sql.includes('information_schema.columns') ? currentColumns() : []);
}

export function rowsByInformationSchemaTable(rows: InformationSchemaRows): (sql: string) => Rows {
  return (sql) => {
    const table = (['columns', 'statistics', 'partitions'] as const).find((name) => sql.includes(`information_schema.${name}`));
    return table === undefined ? [] : (rows[table] ?? []);
  };
}

export function failingIntrospection(message: string): () => Rows {
  return () => {
    throw new Error(message);
  };
}

function mysqlPlugin(seen: string[], sessions: (string | undefined)[], rowsFor: (sql: string) => Rows): TapRootPlugin {
  return {
    manifest: { name: 'mysql', capabilities: ['executeRead'] },
    async execute(request, creds) {
      seen.push(request.query);
      sessions.push(creds[SESSION_CREDENTIAL_KEY]);
      const rows = rowsFor(request.query);
      return {
        datasource: request.datasource.name,
        plugin: 'mysql',
        capability: request.capability,
        query: { native: request.query },
        result: { columns: Object.keys(rows[0] ?? {}), rows: rows.map((row) => Object.values(row)) },
        timings: { startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 1 },
        warnings: [],
        classification: 'success',
      };
    },
  };
}

export function makeContext(rowsFor: (sql: string) => Rows = columnRowsOnly(() => ORDERS_COLUMNS)): {
  ctx: AppContext;
  seen: string[];
  sessions: (string | undefined)[];
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-catalog-'));
  const seen: string[] = [];
  const sessions: (string | undefined)[] = [];
  const previousStateRoot = process.env.TAPROOT_STATE_ROOT;
  process.env.TAPROOT_STATE_ROOT = root;
  const base = buildContext({ kbDir: undefined, verbose: false, plugins: [mysqlPlugin(seen, sessions, rowsFor)], useKeychain: false });
  process.env.TAPROOT_STATE_ROOT = previousStateRoot;
  return { ctx: { ...base, credentialStore: new FixedCredentialStore(path.join(root, 'unused'), false) }, seen, sessions };
}

export function datasource(kind = 'mysql', name = 'qa-orders'): DatasourceProfile {
  return {
    name,
    kind,
    env: 'qa',
    service: 'orders',
    connection: { host: '127.0.0.1', port: 3306, database: 'orders' },
    credentialRef: 'qa:orders',
    connectors: [],
    policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
    updatedAt: new Date().toISOString(),
  };
}

export function backdateCatalog(ctx: AppContext, name: string, ageMs: number): void {
  const catalogFile = path.join(ctx.paths.cacheDir, 'schema', `${name}.json`);
  const catalog = ctx.schemaCatalogStore.get(name);
  const fetchedAt = new Date(Date.now() - ageMs).toISOString();
  fs.writeFileSync(catalogFile, JSON.stringify({ ...catalog, fetchedAt }));
}

export function cachedTableNames(ctx: AppContext, name: string): string[] {
  return Object.keys(ctx.schemaCatalogStore.get(name)?.tables ?? {});
}
