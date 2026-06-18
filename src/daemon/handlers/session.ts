import { str } from '../../core/strings.js';
import { closeAllTeleportMysqlProxies, closeTeleportMysqlSessionProxies } from '../../plugins-builtins/teleport-mysql/index.js';
import type { Handler } from './types.js';

export const handleSessionOpen: Handler = async ({ req, base, deps }) => {
  const session = deps.sessions.open({
    datasourceName: String(req.params.datasource || req.params.datasourceName || 'unknown'),
    env: str(req.params.env),
    namespace: str(req.params.namespace),
    service: str(req.params.service),
    kind: str(req.params.kind),
    connection: (req.params.connection as Record<string, unknown>) || {},
    connectors: Array.isArray(req.params.connectors) ? (req.params.connectors as string[]) : [],
  });
  base.ok = true;
  base.data = { session };
  base.meta.sessionId = session.sessionId;
};

export const handleSessionList: Handler = async ({ base, deps }) => {
  base.ok = true;
  base.data = { sessions: deps.sessions.list() };
};

export const handleSessionInspect: Handler = async ({ req, base, deps }) => {
  const sessionId = str(req.params.sessionId);
  const session = deps.sessions.get(sessionId);
  if (!session) {
    base.ok = false;
    base.error = { code: 'NOT_FOUND', message: `Session not found: ${sessionId}` };
    return;
  }
  base.ok = true;
  base.data = { session };
  base.meta.sessionId = session.sessionId;
};

export const handleSessionClose: Handler = async ({ req, base, deps }) => {
  const sessionId = str(req.params.sessionId);
  const closed = deps.sessions.close(sessionId);
  if (!closed) {
    base.ok = false;
    base.error = { code: 'NOT_FOUND', message: `Session not found: ${sessionId}` };
    return;
  }
  await closeTeleportMysqlSessionProxies(sessionId);
  base.ok = true;
  base.data = { closed: true, sessionId };
  base.meta.sessionId = sessionId;
};

export const handleSessionCloseAll: Handler = async ({ base, deps }) => {
  const closedCount = deps.sessions.closeAll();
  await closeAllTeleportMysqlProxies();
  base.ok = true;
  base.data = { closedCount };
};
