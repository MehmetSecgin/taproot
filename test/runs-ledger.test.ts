import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatasourceProfile } from '../src/types/core.js';
import {
  appendRunsLedgerEntry,
  normalizeSqlForLedger,
  queryFingerprint,
  readRunsLedgerEntries,
  redactSqlForLedger,
} from '../src/core/runs-ledger.js';
import { buildQueryMemory, resolveReason } from '../src/core/query-memory.js';
import { RuntimeConfigStore } from '../src/store/runtime-config.js';

const originalLedger = process.env.TAPROOT_LEDGER;
const originalReason = process.env.TAPROOT_REASON;
const originalTask = process.env.TAPROOT_AGENT_TASK;

afterEach(() => {
  if (originalLedger === undefined) delete process.env.TAPROOT_LEDGER;
  else process.env.TAPROOT_LEDGER = originalLedger;
  if (originalReason === undefined) delete process.env.TAPROOT_REASON;
  else process.env.TAPROOT_REASON = originalReason;
  if (originalTask === undefined) delete process.env.TAPROOT_AGENT_TASK;
  else process.env.TAPROOT_AGENT_TASK = originalTask;
});

function tmpDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `taproot-${name}-`));
}

const datasource: DatasourceProfile = {
  name: 'prod-order-processor',
  kind: 'mysql',
  env: 'prod',
  service: 'order-processor',
  tags: [],
  connection: { database: 'order_service', target: 'prod-target' },
  credentialRef: 'prod:order-processor',
  connectors: [],
  policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
  updatedAt: '2026-05-02T00:00:00.000Z',
  confidence: 1,
};

describe('runs ledger', () => {
  it('normalizes SQL into a stable fingerprint shape', () => {
    const a = normalizeSqlForLedger("SELECT id FROM t WHERE name = 'Ada' AND id = 42");
    const b = normalizeSqlForLedger(" select id from t where name='Bob' and id=99 ");
    expect(a).toContain(':str');
    expect(a).toContain(':num');
    expect(queryFingerprint({ datasource: 'ds', normalizedSql: a })).toBe(
      queryFingerprint({ datasource: 'ds', normalizedSql: b }),
    );
  });

  it('applies redaction tiers and always-redacts sensitive patterns', () => {
    const sql = "SELECT 'alice@example.com' AS email, 'normal' AS name, 123 AS id, 'Bearer abc.def.ghi' AS token";
    expect(redactSqlForLedger(sql, 'raw')).toContain('[REDACTED_EMAIL]');
    expect(redactSqlForLedger(sql, 'raw')).toContain('normal');
    expect(redactSqlForLedger(sql, 'redact')).not.toContain('normal');
    expect(redactSqlForLedger(sql, 'strict')).toContain(':num');
  });

  it('appends and reads JSONL entries', () => {
    const ledgerDir = tmpDir('ledger');
    const entry = appendRunsLedgerEntry({
      ledgerDir,
      runId: 'run-1',
      datasource,
      reason: 'debug missing orders',
      sql: "SELECT id FROM order_items WHERE order_date = '2026-05-02'",
      tables: ['order_items'],
      capability: 'executeRead',
      outcomeCode: 'ok',
      rowCount: 1,
      columns: ['id'],
      redactionTier: 'strict',
      ts: '2026-05-02T10:00:00.000Z',
    });
    expect(entry?.fingerprint).toMatch(/^fp_/);
    const rows = readRunsLedgerEntries(ledgerDir);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('debug missing orders');
    expect(rows[0].sql).not.toContain('2026');
  });

  it('reads only the newest entries up to the limit across month files', () => {
    // arrange
    const ledgerDir = tmpDir('ledger-limit');
    const append = (runId: string, ts: string) =>
      appendRunsLedgerEntry({
        ledgerDir,
        runId,
        datasource,
        sql: 'SELECT 1',
        tables: [],
        capability: 'executeRead',
        outcomeCode: 'ok',
        redactionTier: 'raw',
        ts,
      });
    append('run-1', '2026-04-30T10:00:00.000Z');
    append('run-2', '2026-05-01T10:00:00.000Z');
    append('run-3', '2026-05-02T10:00:00.000Z');

    // act
    const two = readRunsLedgerEntries(ledgerDir, 2);
    const all = readRunsLedgerEntries(ledgerDir, 10);

    // assert
    expect(two.map((row) => row.runId)).toEqual(['run-3', 'run-2']);
    expect(all.map((row) => row.runId)).toEqual(['run-3', 'run-2', 'run-1']);
  });

  it('honors TAPROOT_LEDGER=off', () => {
    const ledgerDir = tmpDir('ledger-off');
    process.env.TAPROOT_LEDGER = 'off';
    const entry = appendRunsLedgerEntry({
      ledgerDir,
      runId: 'run-1',
      datasource,
      sql: 'SELECT 1',
      tables: [],
      capability: 'executeRead',
      outcomeCode: 'ok',
      redactionTier: 'raw',
    });
    expect(entry).toBeUndefined();
    expect(readRunsLedgerEntries(ledgerDir)).toEqual([]);
  });

  it('resolves free-text reasons from flag first and env fallback second', () => {
    process.env.TAPROOT_REASON = 'env reason';
    process.env.TAPROOT_AGENT_TASK = 'task reason';
    expect(resolveReason('flag reason')).toBe('flag reason');
    expect(resolveReason()).toBe('env reason');
    delete process.env.TAPROOT_REASON;
    expect(resolveReason()).toBe('task reason');
  });

  it('builds query memory hints for missing reason and recurring failures', () => {
    const ledgerDir = tmpDir('query-memory');
    for (const runId of ['run-1', 'run-2']) {
      appendRunsLedgerEntry({
        ledgerDir,
        runId,
        datasource,
        sql: 'SELECT id FROM order_items WHERE customer_id = 1',
        tables: ['order_items'],
        capability: 'executeRead',
        outcomeCode: 'MISSING_PARTITION_PREDICATE',
        errorClass: 'MISSING_PARTITION_PREDICATE',
        redactionTier: 'strict',
        ts: `2026-05-02T10:00:0${runId.endsWith('1') ? '1' : '2'}.000Z`,
      });
    }
    const memory = buildQueryMemory({
      ledgerDir,
      datasource: datasource.name,
      env: datasource.env,
      service: datasource.service,
      sql: 'SELECT id FROM order_items WHERE customer_id = 2',
      tables: ['order_items'],
    });
    expect((memory.hints || []).some((hint) => hint.startsWith('reason_missing'))).toBe(true);
    expect((memory.hints || []).some((hint) => hint.includes('partition predicate'))).toBe(true);
    expect(memory.similarPastRuns || []).toHaveLength(2);
  });

  it('uses env-aware default redaction tiers from runtime config', () => {
    const root = tmpDir('runtime');
    const file = path.join(root, 'deterministic-config.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        defaults: { ledger: { redactionTier: 'redact' } },
        environmentPolicies: { prod: { ledgerRedactionTier: 'strict' }, sandbox: { ledgerRedactionTier: 'raw' } },
      }),
    );
    const store = new RuntimeConfigStore(file);
    expect(store.ledgerRedactionTier('prod')).toBe('strict');
    expect(store.ledgerRedactionTier('sandbox')).toBe('raw');
    expect(store.ledgerRedactionTier('qa')).toBe('redact');
  });
});
