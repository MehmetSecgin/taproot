import type { Connection, ConnectionOptions } from 'mysql2/promise';
import { queryTimeoutError } from '../../core/query-timeout.js';
import { DEFAULT_SESSION_TIME_ZONE } from '../../core/session-timezone.js';
import { enrichResourceLimitError, enrichSqlSyntaxError } from '../../core/sql-hints.js';
import { nowIso } from '../../core/time.js';
import type { QueryRequest, QueryResult } from '../../types/plugin.js';
import { leaseMysqlConnection } from './mysql-connection-lease.js';
import { errorText } from '../../core/error-text.js';
import { destroyConnectionAndSocket, streamRowsUntilAborted } from './mysql-row-stream.js';

function translateQueryError(conn: Connection, error: unknown, request: QueryRequest): unknown {
  const message = errorText(error);
  if (request.timeoutMs !== undefined && request.timeoutMs !== 0 && /timeout/iu.test(message)) {
    destroyConnectionAndSocket(conn);
    return queryTimeoutError(request.timeoutMs);
  }
  const enriched = enrichSqlSyntaxError(enrichResourceLimitError(message), request.query);
  return enriched === message ? error : new Error(enriched);
}

type MysqlExecution = {
  plugin: string;
  request: QueryRequest;
  config: ConnectionOptions;
  sessionId: string | undefined;
};

export async function executeMysqlQuery({ plugin, request, config, sessionId }: MysqlExecution): Promise<QueryResult> {
  const startedAt = nowIso();
  const start = Date.now();
  const timeZone = request.sessionTimeZone === '' ? DEFAULT_SESSION_TIME_ZONE : request.sessionTimeZone;
  const { conn, release } = await leaseMysqlConnection(config, timeZone, {
    capability: request.capability,
    sessionId,
    signal: request.signal,
    timeoutMs: request.timeoutMs,
  });
  try {
    const options = { timeoutMs: request.timeoutMs, maxRows: request.maxRows, signal: request.signal };
    const result = await streamRowsUntilAborted(conn, request.query, options);
    return {
      datasource: request.datasource.name,
      plugin,
      capability: request.capability,
      query: { native: request.query },
      result,
      timings: { startedAt, endedAt: nowIso(), durationMs: Date.now() - start },
      warnings: [],
      classification: 'success',
    };
  } catch (error) {
    throw translateQueryError(conn, error, request);
  } finally {
    await release();
  }
}
