import path from 'node:path';
import { executeQuery, silentQueryReport } from '../../src/core/execute-query.js';
import type { QueryExecutionRequest, QueryOutcome } from '../../src/core/query-types.js';
import { rpcCall } from '../../src/daemon/client.js';
import type { RpcResponse } from '../../src/daemon/types.js';
import type { TapRootPlugin } from '../../src/types/plugin.js';
import { startLocalDaemon } from './daemon.js';
import { storeResolver } from './execute-query-state.js';
import { fakePlugin } from './fake-plugin.js';
import { contextWith } from './query-state.js';

export type ParityRun = { direct: QueryOutcome; rpc: RpcResponse };

export type ParityInput = {
  stateRoot: string;
  request: QueryExecutionRequest;
  makePlugin?: () => TapRootPlugin;
};

export async function runBothPaths(input: ParityInput): Promise<ParityRun> {
  const makePlugin = input.makePlugin ?? ((): TapRootPlugin => fakePlugin());
  const direct = await executeQuery(input.request, {
    ctx: contextWith(makePlugin()),
    report: silentQueryReport,
    signal: undefined,
    acquireQuerySlot: undefined,
    resolveDatasource: storeResolver,
  });
  const socketPath = path.join(input.stateRoot, 'run', 'taprootd-parity.sock');
  const daemon = await startLocalDaemon({ stateRoot: input.stateRoot, socketPath, plugins: [makePlugin()] });
  try {
    const rpc = await rpcCall({ socketPath, method: 'query.execute', params: { ...input.request }, timeoutMs: 10_000 });
    return { direct, rpc };
  } finally {
    await daemon.stop();
  }
}
