import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveQueryTarget, executeQuery, silentQueryReport } from '../src/core/execute-query.js';
import type { QueryPhase, QueryReport } from '../src/core/execute-query.js';
import { DatasourceStore } from '../src/store/datasources.js';
import type { DatasourceProfile, QueryResult, TapRootPlugin } from '../src/types/core.js';
import { fakePlugin } from './helpers/fake-plugin.js';
import { contextWith, queryRequest, restoreQueryEnv, setupQueryState } from './helpers/query-state.js';

let stateRoot = '';

function recordingReport(): { report: QueryReport; phases: Array<[QueryPhase, number]>; updates: string[]; notices: string[] } {
  const phases: Array<[QueryPhase, number]> = [];
  const updates: string[] = [];
  const notices: string[] = [];
  return {
    phases,
    updates,
    notices,
    report: {
      update: (m) => updates.push(m),
      phase: (p, ms) => phases.push([p, ms]),
      verbose: () => {},
      notice: (m) => notices.push(m),
    },
  };
}

function capturingPlugin(capture: { query?: string; creds?: Record<string, string> }): TapRootPlugin {
  const plugin = fakePlugin();
  const inner = plugin.execute!;
  plugin.execute = async (request, creds): Promise<QueryResult> => {
    capture.query = request.query;
    capture.creds = creds;
    return inner(request, creds);
  };
  return plugin;
}

function ledgerEntries(): string[] {
  const ledgerDir = path.join(stateRoot, 'learning', 'runs-ledger');
  if (!fs.existsSync(ledgerDir)) return [];
  return fs
    .readdirSync(ledgerDir)
    .flatMap((file) => fs.readFileSync(path.join(ledgerDir, file), 'utf8').split('\n').filter(Boolean));
}

beforeEach(async () => {
  stateRoot = await setupQueryState();
});

afterEach(() => {
  restoreQueryEnv();
});

describe('executeQuery success', () => {
  it('returns the shaped envelope and phase timings', async () => {
    // arrange
    const ctx = contextWith(fakePlugin());
    const recorder = recordingReport();

    // act
    const outcome = await executeQuery(queryRequest(), { ctx, report: recorder.report });

    // assert
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data).toMatchObject({
      columns: ['ok'],
      rows: [[1]],
      rowsForm: 'array',
      datasource: 'qa-fake',
      plugin: 'fake',
      classification: 'success',
    });
    expect(outcome.meta.runId).toBeTruthy();
    expect(outcome.meta.resolved).toMatchObject({ env: 'qa', service: 'fake', engine: 'fake' });
    expect(recorder.phases.map(([phase]) => phase)).toEqual(['resolve', 'connect', 'execute']);
  });

  it('omits rowsForm and returns objects when rowsObject is set', async () => {
    const ctx = contextWith(fakePlugin());
    const outcome = await executeQuery(queryRequest({ rowsObject: true }), { ctx, report: silentQueryReport });
    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.data.rows).toEqual([{ ok: 1 }]);
    expect(outcome.data.rowsForm).toBeUndefined();
  });

  it('wraps the query with EXPLAIN when explain is set', async () => {
    const capture: { query?: string } = {};
    const ctx = contextWith(capturingPlugin(capture));
    await executeQuery(queryRequest({ explain: true }), { ctx, report: silentQueryReport });
    expect(capture.query).toBe('EXPLAIN SELECT 1 AS ok');
  });

  it('applies json extract specs to the returned columns', async () => {
    const ctx = contextWith(fakePlugin({ columns: ['payload'], rows: [{ payload: '{"order":{"id":7}}' }] }));
    const outcome = await executeQuery(queryRequest({ jsonExtract: ['payload:order.id'] }), {
      ctx,
      report: silentQueryReport,
    });
    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.data.columns).toContain('payload.order.id');
    expect(outcome.data.rows[0]).toEqual(['{"order":{"id":7}}', 7]);
  });

  it('reports plugin warnings once', async () => {
    const ctx = contextWith(fakePlugin({ warnings: ['slow scan'] }));
    const outcome = await executeQuery(queryRequest(), { ctx, report: silentQueryReport });
    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.data.warnings).toEqual(['slow scan']);
  });

  it('writes a run summary and a ledger entry', async () => {
    const ctx = contextWith(fakePlugin());
    const outcome = await executeQuery(queryRequest(), { ctx, report: silentQueryReport });
    if (!outcome.ok) throw new Error('expected success');
    const summary = path.join(stateRoot, 'runs', outcome.meta.runId!, 'summary.json');
    expect(fs.existsSync(summary)).toBe(true);
    expect(ledgerEntries().length).toBe(1);
  });

  it('emits the catalog notice on the first query against a sql datasource', async () => {
    stateRoot = await setupQueryState({ kind: 'mysql' });
    const ctx = contextWith(fakePlugin({ kind: 'mysql' }));
    const recorder = recordingReport();
    await executeQuery(queryRequest(), { ctx, report: recorder.report });
    expect(recorder.notices.join(' ')).toContain('qa-fake');
  });
});

describe('executeQuery session identity', () => {
  it('passes the id from openSession to the plugin credentials', async () => {
    const capture: { creds?: Record<string, string> } = {};
    const ctx = contextWith(capturingPlugin(capture));
    const outcome = await executeQuery(queryRequest(), {
      ctx,
      report: silentQueryReport,
      openSession: () => 'session-123',
    });
    expect(capture.creds?.__sessionId).toBe('session-123');
    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.meta.sessionId).toBe('session-123');
  });

  it('calls openSession with the resolved datasource', async () => {
    const ctx = contextWith(fakePlugin());
    const openSession = vi.fn((_datasource: DatasourceProfile) => 'session-abc');
    await executeQuery(queryRequest(), { ctx, report: silentQueryReport, openSession });
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(openSession.mock.calls[0][0]).toMatchObject({ name: 'qa-fake', kind: 'fake' });
  });

  it('omits the session marker when no session is opened', async () => {
    const capture: { creds?: Record<string, string> } = {};
    const ctx = contextWith(capturingPlugin(capture));
    await executeQuery(queryRequest(), { ctx, report: silentQueryReport });
    expect(capture.creds?.__sessionId).toBeUndefined();
  });
});

describe('executeQuery failure', () => {
  it('rejects a malformed param before any run is recorded', async () => {
    const ctx = contextWith(fakePlugin());
    const outcome = await executeQuery(queryRequest({ params: ['brokenpair'] }), { ctx, report: silentQueryReport });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('BAD_INPUT');
    expect(outcome.message).toContain("Invalid --param 'brokenpair'");
    expect(outcome.meta.runId).toBeUndefined();
    expect(ledgerEntries().length).toBe(0);
  });

  it('rejects an empty query', async () => {
    const ctx = contextWith(fakePlugin());
    const outcome = await executeQuery(queryRequest({ query: '   ' }), { ctx, report: silentQueryReport });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('No query resolved');
  });

  it('blocks a mutating query without allowMutate and records the failure', async () => {
    const ctx = contextWith(fakePlugin());
    const outcome = await executeQuery(queryRequest({ query: 'DELETE FROM orders' }), {
      ctx,
      report: silentQueryReport,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('--allow-mutate');
    expect(outcome.meta.runId).toBeTruthy();
    expect(ledgerEntries().length).toBe(1);
  });

  it('classifies a plugin failure and keeps the run metadata', async () => {
    const ctx = contextWith(fakePlugin({ failWith: 'access denied for user' }));
    const outcome = await executeQuery(queryRequest(), { ctx, report: silentQueryReport });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('ACCESS_DENIED');
    expect(outcome.meta.runId).toBeTruthy();
    expect(outcome.meta.queryMemory).toBeDefined();
  });

  it('fails when no plugin serves the datasource kind', async () => {
    const ctx = contextWith(fakePlugin({ kind: 'other' }));
    const outcome = await executeQuery(queryRequest(), { ctx, report: silentQueryReport });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('No execute-capable plugin');
  });

  it('fails when the datasource cannot be resolved', async () => {
    const ctx = contextWith(fakePlugin());
    const outcome = await executeQuery(queryRequest({ datasource: 'missing', env: '', service: '' }), {
      ctx,
      report: silentQueryReport,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('Datasource resolution failed');
  });
});

function countingPlugin(failWith: string, calls: { count: number }): TapRootPlugin {
  const plugin = fakePlugin({ failWith });
  const inner = plugin.execute!;
  plugin.execute = async (request, creds): Promise<QueryResult> => {
    calls.count += 1;
    return inner(request, creds);
  };
  return plugin;
}

describe('executeQuery repeat guard', () => {
  it('short-circuits the same query after a syntax error and returns the prior error', async () => {
    // arrange
    const calls = { count: 0 };
    const ctx = contextWith(countingPlugin("You have an error in your SQL syntax; check the manual near 'SELEC'", calls));
    await executeQuery(queryRequest({ query: 'SELEC 1' }), { ctx, report: silentQueryReport });

    // act
    const outcome = await executeQuery(queryRequest({ query: 'SELEC 1' }), { ctx, report: silentQueryReport });

    // assert
    expect(calls.count).toBe(1);
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.code).toBe('SQL_SYNTAX');
    expect(outcome.message).toContain('short-circuited');
    expect(outcome.message).toContain("near 'SELEC'");
    expect(outcome.details).toMatchObject({ shortCircuited: true });
    expect(ledgerEntries().length).toBe(1);
  });

  it('short-circuits any query on a datasource after a connectivity failure', async () => {
    // arrange
    const calls = { count: 0 };
    const ctx = contextWith(countingPlugin('getaddrinfo ENOTFOUND example-svc.test-ns', calls));
    await executeQuery(queryRequest(), { ctx, report: silentQueryReport });

    // act
    const outcome = await executeQuery(queryRequest({ query: 'SELECT 2 AS ok' }), { ctx, report: silentQueryReport });

    // assert
    expect(calls.count).toBe(1);
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.code).toBe('CONNECTIVITY');
    expect(outcome.message).toContain('datasource qa-fake');
  });

  it('runs a repeated query again when the prior failure is not deterministic', async () => {
    // arrange
    const calls = { count: 0 };
    const ctx = contextWith(countingPlugin('access denied for user', calls));
    await executeQuery(queryRequest(), { ctx, report: silentQueryReport });

    // act
    await executeQuery(queryRequest(), { ctx, report: silentQueryReport });

    // assert
    expect(calls.count).toBe(2);
  });
});

describe('executeQuery datasource kind routing', () => {
  function saveProfile(overrides: Partial<DatasourceProfile>): void {
    new DatasourceStore(path.join(stateRoot, 'config', 'datasources.json')).save({
      name: 'qa-svc-sql',
      kind: 'mysql',
      env: 'qa',
      service: 'svc',
      tags: [],
      connection: { host: '127.0.0.1', port: 1, database: 'svc' },
      credentialRef: 'qa:fake',
      policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
      updatedAt: new Date().toISOString(),
      confidence: 0.5,
      ...overrides,
    } as DatasourceProfile);
  }

  function bothKinds() {
    const ctx = contextWith(fakePlugin({ kind: 'grpc' }));
    ctx.pluginRegistry.register(fakePlugin({ kind: 'mysql' }));
    return ctx;
  }

  it('sends SQL text to the sql datasource when env and service also match a grpc one', async () => {
    stateRoot = await setupQueryState({ name: 'qa-svc-grpc', kind: 'grpc', service: 'svc', confidence: 1 });
    saveProfile({ name: 'qa-svc-sql', kind: 'mysql', confidence: 0.5 });
    const outcome = await executeQuery(queryRequest({ datasource: undefined, service: 'svc', query: 'SELECT 1 AS ok' }), {
      ctx: bothKinds(),
      report: silentQueryReport,
    });
    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.data.datasource).toBe('qa-svc-sql');
  });

  it('sends Service/method text to the grpc datasource when env and service also match a sql one', async () => {
    stateRoot = await setupQueryState({ name: 'qa-svc-grpc', kind: 'grpc', service: 'svc', confidence: 0.5 });
    saveProfile({ name: 'qa-svc-sql', kind: 'mysql', confidence: 1 });
    const outcome = await executeQuery(
      queryRequest({ datasource: undefined, service: 'svc', query: 'taproot.test.ProfileService/getProfile' }),
      { ctx: bothKinds(), report: silentQueryReport },
    );
    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.data.datasource).toBe('qa-svc-grpc');
  });

  it('keeps the only matching datasource even when its kind does not fit the query', async () => {
    stateRoot = await setupQueryState({ name: 'qa-svc-grpc', kind: 'grpc', service: 'svc' });
    const outcome = await executeQuery(queryRequest({ datasource: undefined, service: 'svc', query: 'SELECT 1 AS ok' }), {
      ctx: bothKinds(),
      report: silentQueryReport,
    });
    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.data.datasource).toBe('qa-svc-grpc');
  });

  it('honours an explicit --datasource regardless of the query text', async () => {
    stateRoot = await setupQueryState({ name: 'qa-svc-grpc', kind: 'grpc', service: 'svc', confidence: 1 });
    saveProfile({ name: 'qa-svc-sql', kind: 'mysql', confidence: 0.5 });
    const outcome = await executeQuery(queryRequest({ datasource: 'qa-svc-grpc', service: 'svc', query: 'SELECT 1 AS ok' }), {
      ctx: bothKinds(),
      report: silentQueryReport,
    });
    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.data.datasource).toBe('qa-svc-grpc');
  });
});

describe('executeQuery password prompt', () => {
  it('prompts once and retries when access is denied', async () => {
    // arrange
    stateRoot = await setupQueryState({ kind: 'mysql' });
    let attempts = 0;
    const plugin = fakePlugin({ kind: 'mysql' });
    const catalogResult = (request: { datasource: { name: string }; capability: unknown; query: string }): QueryResult => ({
      runId: '',
      datasource: request.datasource.name,
      plugin: 'mysql',
      capability: request.capability as never,
      query: { native: request.query },
      result: { columns: [], rows: [] },
      timings: { startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 1 },
      warnings: [],
      classification: 'success',
    });
    plugin.execute = async (request, creds): Promise<QueryResult> => {
      if (request.query.includes('information_schema')) return catalogResult(request);
      attempts += 1;
      if (attempts === 1) throw new Error('access denied for user');
      return {
        runId: '',
        datasource: request.datasource.name,
        plugin: 'mysql',
        capability: request.capability,
        query: { native: request.query },
        result: { columns: ['ok'], rows: [{ ok: creds.password }] },
        timings: { startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 1 },
        warnings: [],
        classification: 'success',
      };
    };
    const ctx = contextWith(plugin);
    await ctx.credentialStore.set('qa:fake', { user: 'x' });
    const promptPassword = vi.fn(async () => 'typed-secret');

    // act
    const outcome = await executeQuery(queryRequest({ datasource: 'qa-fake' }), {
      ctx,
      report: silentQueryReport,
      promptPassword,
    });

    // assert
    expect(promptPassword).toHaveBeenCalledTimes(1);
    expect(attempts).toBe(2);
    if (!outcome.ok) throw new Error('expected success after retry');
    expect(outcome.data.rows).toEqual([['typed-secret']]);
  });

  it('does not retry when no prompt dependency is supplied', async () => {
    const ctx = contextWith(fakePlugin({ failWith: 'access denied for user' }));
    await ctx.credentialStore.set('qa:fake', { user: 'x' });
    const outcome = await executeQuery(queryRequest(), { ctx, report: silentQueryReport });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('ACCESS_DENIED');
  });
});

describe('deriveQueryTarget', () => {
  it('takes env, namespace and service from an explicit profile', async () => {
    const ctx = contextWith(fakePlugin());
    expect(deriveQueryTarget(ctx, { datasource: 'qa-fake' })).toMatchObject({ env: 'qa', service: 'fake' });
  });

  it('parses env and service out of an alias when no profile matches', async () => {
    const ctx = contextWith(fakePlugin());
    expect(deriveQueryTarget(ctx, { datasource: 'stg-orders' })).toMatchObject({ env: 'stg', service: 'orders' });
  });

  it('prefers explicit env and service over the alias', async () => {
    const ctx = contextWith(fakePlugin());
    expect(deriveQueryTarget(ctx, { datasource: 'stg-orders', env: 'qa', service: 'billing' })).toMatchObject({
      env: 'qa',
      service: 'billing',
    });
  });

  it('returns empty strings when nothing identifies the target', async () => {
    const ctx = contextWith(fakePlugin());
    expect(deriveQueryTarget(ctx, {})).toMatchObject({ env: '', service: '' });
  });
});
