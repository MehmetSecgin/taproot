import type net from 'node:net';
import { createHandlerDeps } from './handler-deps.js';
import { bindServer, closeOnce, createListener } from './listener.js';
import type { Listener } from './listener.js';
import { refuseOtherVersion, stopForOtherVersion } from './methods/status.js';
import type { HandlerDeps } from './methods/types.js';
import { serveConnection } from './server-connection.js';
import type { ConnectionActivity, ConnectionServing } from './server-connection.js';
import type { StartDaemonInput } from './server.js';

export type ServingDaemon = {
  server: net.Server;
  deps: HandlerDeps;
  activity: ConnectionActivity;
  watchCertificates: Listener['watchCertificates'];
  stopAcceptingConnections: () => Promise<void>;
};

function connectionServing(input: StartDaemonInput, parts: { deps: HandlerDeps; activity: ConnectionActivity; stopAcceptingConnections: () => Promise<void> }): ConnectionServing {
  return {
    handlers: new Map(input.methods.map((method) => [method.name, method.handle])),
    onOtherVersion: input.listen.kind === 'unix' ? stopForOtherVersion : refuseOtherVersion,
    deps: parts.deps,
    activity: parts.activity,
    log: input.log,
    stopAcceptingConnections: () => {
      void parts.stopAcceptingConnections();
    },
  };
}

export async function openServing(input: StartDaemonInput): Promise<ServingDaemon> {
  const startedAt = Date.now();
  const activity: ConnectionActivity = { activeRequests: 0, lastActivityAt: startedAt };
  const { server, serveConnectionsWith, watchCertificates } = createListener(input.listen, input.log);
  const stopAcceptingConnections = closeOnce(server);
  const deps = createHandlerDeps(input, server, startedAt);
  const serving = connectionServing(input, { deps, activity, stopAcceptingConnections });
  serveConnectionsWith((socket) => {
    serveConnection(socket, serving);
  });
  await bindServer(server, input.listen);
  return { server, deps, activity, watchCertificates, stopAcceptingConnections };
}
