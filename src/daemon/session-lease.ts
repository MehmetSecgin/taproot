import { RUNTIME_CONSTANTS } from '../core/constants.js';
import type { DatasourceProfile } from '../types/datasource.js';
import type { SessionRegistry } from './session-registry.js';

export type SessionLease = {
  sessionId: string;
  release: () => void;
};

export function leaseSession(sessions: SessionRegistry, datasource: DatasourceProfile): SessionLease {
  const { sessionId } = sessions.open({
    datasourceName: datasource.name,
    env: datasource.env,
    namespace: datasource.namespace,
    service: datasource.service,
    kind: datasource.kind,
    connection: datasource.connection,
    connectors: datasource.connectors,
  });
  const leaseId = sessions.acquireLease(sessionId);
  const heartbeat = setInterval(() => {
    sessions.heartbeatLease(sessionId, leaseId);
  }, RUNTIME_CONSTANTS.session.leaseHeartbeatIntervalMs);
  return {
    sessionId,
    release: () => {
      clearInterval(heartbeat);
      sessions.releaseLease(sessionId, leaseId);
    },
  };
}
