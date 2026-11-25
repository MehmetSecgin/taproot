import { describe, expect, it } from 'vitest';
import { useQueryStateRoot } from './helpers/execute-query-state.js';
import { fakePlugin, interceptExecute } from './helpers/fake-plugin.js';
import { expectFailure, expectSuccess } from './helpers/query-outcome.js';
import { runBothPaths } from './helpers/query-parity-paths.js';
import { queryRequest } from './helpers/query-state.js';

describe('query parity between the direct and daemon adapters', () => {
  const stateRoot = useQueryStateRoot();

  it('produces the same success envelope on both paths', async () => {
    const { direct, rpc } = await runBothPaths({ stateRoot: stateRoot(), request: queryRequest() });

    const success = expectSuccess(direct);
    expect(rpc.ok).toBe(true);
    expect(rpc.data).toStrictEqual(success.data);
    expect(success.data.columns).toStrictEqual(['ok']);
    expect(success.data.rows).toStrictEqual([[1]]);
    expect(success.data.rowsForm).toBe('array');
  });

  it('reports the same resolved metadata on both paths', async () => {
    const { direct, rpc } = await runBothPaths({ stateRoot: stateRoot(), request: queryRequest() });
    const success = expectSuccess(direct);
    const sentOverJson = Object.fromEntries(Object.entries({ ...success.meta.resolved }).filter(([, value]) => value !== undefined));
    expect(rpc.meta.resolved).toStrictEqual(sentOverJson);
  });

  it('emits each warning exactly once on both paths', async () => {
    const { direct, rpc } = await runBothPaths({
      stateRoot: stateRoot(),
      request: queryRequest(),
      makePlugin: () => fakePlugin({ warnings: ['partition scan without predicate'] }),
    });
    const success = expectSuccess(direct);
    expect(success.data.warnings).toStrictEqual(['partition scan without predicate']);
    expect(rpc.data?.warnings).toStrictEqual(['partition scan without predicate']);
  });

  it('wraps the query with EXPLAIN on both paths', async () => {
    const seen: string[] = [];
    const { direct, rpc } = await runBothPaths({
      stateRoot: stateRoot(),
      request: queryRequest({ explain: true }),
      makePlugin: () =>
        interceptExecute(fakePlugin(), (request) => {
          seen.push(request.query);
        }),
    });

    const success = expectSuccess(direct);
    expect(rpc.ok).toBe(true);
    expect(seen).toStrictEqual(['EXPLAIN SELECT 1 AS ok', 'EXPLAIN SELECT 1 AS ok']);
    expect(rpc.data).toStrictEqual(success.data);
  });

  it('adds the json-extract derived column on both paths', async () => {
    const { direct, rpc } = await runBothPaths({
      stateRoot: stateRoot(),
      request: queryRequest({ jsonExtract: ['payload:order.id'] }),
      makePlugin: () => fakePlugin({ columns: ['payload'], rows: [['{"order":{"id":"A1"}}']] }),
    });

    const success = expectSuccess(direct);
    expect(success.data.columns).toStrictEqual(['payload', 'payload.order.id']);
    expect(success.data.rows).toStrictEqual([['{"order":{"id":"A1"}}', 'A1']]);
    expect(rpc.data).toStrictEqual(success.data);
  });

  it('rejects a malformed json-extract spec on both paths', async () => {
    const { direct, rpc } = await runBothPaths({ stateRoot: stateRoot(), request: queryRequest({ jsonExtract: ['payload'] }) });

    const failure = expectFailure(direct);
    expect(rpc.ok).toBe(false);
    expect(failure.code).toBe('BAD_INPUT');
    expect(rpc.error?.code).toBe('BAD_INPUT');
  });

  it('rejects a malformed param on both paths', async () => {
    const { direct, rpc } = await runBothPaths({ stateRoot: stateRoot(), request: queryRequest({ params: ['brokenpair'] }) });

    const failure = expectFailure(direct);
    expect(rpc.ok).toBe(false);
    expect(failure.message).toContain("Invalid --param 'brokenpair'");
    expect(rpc.error?.message).toContain("Invalid --param 'brokenpair'");
    expect(failure.code).toBe('BAD_INPUT');
    expect(rpc.error?.code).toBe('BAD_INPUT');
  });

  it('maps session and phase metadata onto the daemon response', async () => {
    const { rpc } = await runBothPaths({ stateRoot: stateRoot(), request: queryRequest() });
    expect(rpc.meta.sessionId).toBeTypeOf('string');
    expect(rpc.meta.resolved).toBeDefined();
    expect(Object.keys({ ...rpc.meta.phases })).toStrictEqual(expect.arrayContaining(['resolveMs', 'executeMs']));
  });

  it('returns rows as objects on both paths when rowsObject is set', async () => {
    const { direct, rpc } = await runBothPaths({ stateRoot: stateRoot(), request: queryRequest({ rowsObject: true }) });
    const success = expectSuccess(direct);
    expect(success.data.rows).toStrictEqual([{ ok: 1 }]);
    expect(rpc.data).toStrictEqual(success.data);
  });
});
