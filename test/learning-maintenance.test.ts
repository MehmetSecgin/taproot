import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRunsLedgerEntries } from '../src/core/runs-ledger.js';
import { LearningStore } from '../src/store/learning.js';
import type {
  GrpcServiceSchemaEntry,
  ResolutionEntry,
  SchemaCatalogEntry,
  SchemaJoinEntry,
  SchemaObservationEntry,
} from '../src/store/learning-types.js';

function learningDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `taproot-${name}-`));
}

function writeRows(dir: string, file: string, rows: unknown[]): void {
  fs.writeFileSync(path.join(dir, file), JSON.stringify(rows), 'utf8');
}

function resolutionRow(key: string, lastVerifiedAt: string): ResolutionEntry {
  return {
    key,
    env: 'qa',
    service: key,
    datasourceName: `qa-${key}`,
    kind: 'mysql',
    connection: { host: '127.0.0.1', port: 3306, database: 'orders' },
    credentialRef: `qa:${key}`,
    connectors: [],
    lastVerifiedAt,
    successCount: 1,
    failureCount: 0,
    confidence: 0.9,
  };
}

function catalogRow(key: string, fetchedAt: string): SchemaCatalogEntry {
  return { key, env: 'qa', service: key, database: 'orders', fetchedAt, tableCount: 3 };
}

function observationRow(key: string, lastSeenAt: string): SchemaObservationEntry {
  return {
    key,
    datasource: 'qa-orders',
    env: 'qa',
    service: 'orders',
    kind: 'mysql',
    database: 'orders',
    target: 'qa-target',
    table: key,
    aliases: [],
    columns: [],
    firstSeenAt: lastSeenAt,
    lastSeenAt,
    sightings: 1,
    confidence: 0.8,
    sources: ['observed-query'],
  };
}

function joinRow(key: string, lastSeenAt: string): SchemaJoinEntry {
  return {
    key,
    datasource: 'qa-orders',
    env: 'qa',
    service: 'orders',
    kind: 'mysql',
    database: 'orders',
    leftTable: 'orders',
    rightTable: 'customers',
    directionHint: 'left-to-right',
    conditionRaw: 'orders.customer_id = customers.id',
    conditionNormalized: 'orders.customer_id=customers.id',
    firstSeenAt: lastSeenAt,
    lastSeenAt,
    sightings: 1,
    confidence: 0.8,
    sources: ['observed-query'],
  };
}

function grpcRow(key: string, lastSeenAt: string): GrpcServiceSchemaEntry {
  return {
    key,
    datasource: 'qa-orders-grpc',
    env: 'qa',
    service: 'orders',
    kind: 'grpc',
    protoRoot: '/protos',
    services: [],
    messages: {},
    enums: {},
    firstSeenAt: lastSeenAt,
    lastSeenAt,
    sources: ['observed-query'],
  };
}

describe('learning store maintenance', () => {
  it('reports the newest timestamp from status() after compact reorders rows by key', () => {
    // arrange
    const dir = learningDir('learning-status');
    writeRows(dir, 'schema-catalog.json', [
      catalogRow('aaa-newest', '2026-05-02T00:00:00.000Z'),
      catalogRow('zzz-oldest', '2026-01-01T00:00:00.000Z'),
    ]);
    writeRows(dir, 'resolution-cache.json', [resolutionRow('mmm-middle', '2026-03-01T00:00:00.000Z')]);
    const store = new LearningStore(dir);

    // act
    store.compact();

    // assert
    expect(store.status().latest).toBe('2026-05-02T00:00:00.000Z');
  });

  it('prunes rows with unparseable timestamps from every learning file', () => {
    // arrange
    const dir = learningDir('learning-prune');
    writeRows(dir, 'resolution-cache.json', [resolutionRow('orders', 'not-a-date')]);
    writeRows(dir, 'schema-observations.json', [observationRow('orders|items', 'not-a-date')]);
    writeRows(dir, 'schema-joins.json', [joinRow('orders|items|customers', 'not-a-date')]);
    writeRows(dir, 'schema-catalog.json', [catalogRow('qa-orders', 'not-a-date')]);
    writeRows(dir, 'grpc-schemas.json', [grpcRow('orders|OrderService', 'not-a-date')]);
    const store = new LearningStore(dir);

    // act
    const result = store.prune(24);

    // assert
    expect(result).toEqual({ before: 5, after: 0 });
    expect(store.status().files).toEqual({
      resolution: 0,
      schemaObservations: 0,
      schemaJoins: 0,
      schemaCatalog: 0,
      grpcSchemas: 0,
    });
  });

  it('keeps catalog rows inside the ttl window while dropping expired ones', () => {
    // arrange
    const dir = learningDir('learning-prune-window');
    const fresh = new Date(Date.now() - 3600 * 1000).toISOString();
    writeRows(dir, 'schema-catalog.json', [
      catalogRow('qa-fresh', fresh),
      catalogRow('qa-stale', '2020-01-01T00:00:00.000Z'),
    ]);
    const store = new LearningStore(dir);

    // act
    const result = store.prune(24);

    // assert
    expect(result).toEqual({ before: 2, after: 1 });
    expect(store.schemaCatalog('qa-fresh')?.fetchedAt).toBe(fresh);
    expect(store.schemaCatalog('qa-stale')).toBeUndefined();
  });

  it('clears the runs ledger nested inside the learning dir', () => {
    // arrange
    const dir = learningDir('learning-clear');
    const ledgerDir = path.join(dir, 'runs-ledger');
    fs.mkdirSync(ledgerDir, { recursive: true });
    fs.writeFileSync(path.join(ledgerDir, '2026-05.jsonl'), '{"runId":"run-1"}\n', 'utf8');
    writeRows(dir, 'schema-catalog.json', [catalogRow('qa-orders', '2026-05-02T00:00:00.000Z')]);
    const store = new LearningStore(dir);

    // act
    store.clear();

    // assert
    expect(store.status().files.schemaCatalog).toBe(0);
    expect(readRunsLedgerEntries(ledgerDir)).toEqual([]);
  });
});
