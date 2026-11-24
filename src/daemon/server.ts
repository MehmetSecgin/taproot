import type { AppContext } from '../core/app.js';
import { registerCleanup } from '../core/process-cleanup.js';
import type { DatasourceCheck } from './datasource-check.js';
import { claimSocket } from './listener.js';
import type { DaemonEndpoint, DaemonMethod } from './methods/types.js';
import { openServing } from './serving.js';
import type { ServingDaemon } from './serving.js';
import { createShutdown, installExitSignalHandlers } from './shutdown.js';
import { startSweeper } from './sweeper.js';
import type { MutualTlsFiles } from './transport.js';

export type DaemonListen =
  | { kind: 'unix'; socketPath: string }
  | { kind: 'tls'; host: string; port: number; tls: MutualTlsFiles; reloadMs: number };

export type DaemonLog = (event: Record<string, unknown>) => void;

export type DaemonInstance = {
  endpoint: DaemonEndpoint;
  stop: () => Promise<void>;
};

export type StartDaemonInput = {
  ctx: AppContext;
  listen: DaemonListen;
  methods: DaemonMethod[];
  checkDatasource: DatasourceCheck | undefined;
  checkDatasourceTtlMs?: number;
  log: DaemonLog;
};

function startTimers(input: StartDaemonInput, serving: ServingDaemon): NodeJS.Timeout[] {
  const sweeper = startSweeper({ ctx: input.ctx, sessions: serving.deps.sessions, activity: serving.activity, exitsWhenIdle: input.listen.kind === 'unix' });
  const certificateWatchers = serving.watchCertificates === undefined ? [] : [serving.watchCertificates()];
  return [sweeper, ...certificateWatchers];
}

export async function startDaemon(input: StartDaemonInput): Promise<DaemonInstance> {
  if (input.listen.kind === 'unix') {
    await claimSocket(input.listen.socketPath);
  }
  const serving = await openServing(input);
  const shutdown = createShutdown(input.ctx, startTimers(input, serving), serving.stopAcceptingConnections);
  const endpoint = serving.deps.endpoint();
  const unregisterShutdown = registerCleanup(`daemon-stop:${JSON.stringify(endpoint)}`, shutdown);
  installExitSignalHandlers();
  return {
    endpoint,
    stop: async () => {
      unregisterShutdown();
      await shutdown();
    },
  };
}
