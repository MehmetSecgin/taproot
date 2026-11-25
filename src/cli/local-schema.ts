import type { AppContext } from '../core/app.js';
import { readSchema, schemaDatasource } from '../core/schema-read.js';
import type { SchemaRequest } from '../core/schema-read.js';
import { readSchemaThroughDaemon } from './local-daemon.js';
import { dataOrThrow } from './query-reply.js';
import { daemonRouteIfAvailable } from './query-route.js';
import { createVerboseLog } from './verbose-log.js';

const NO_QUERY_SLOT = undefined;

export async function readLocalSchema(ctx: AppContext, request: SchemaRequest): Promise<Record<string, unknown>> {
  if (daemonRouteIfAvailable() === 'daemon') {
    const reply = await readSchemaThroughDaemon(request, createVerboseLog(ctx));
    if (reply) {
      return dataOrThrow(reply);
    }
  }
  return readSchema(ctx, { datasource: schemaDatasource(ctx, request.datasource), tables: request.tables, acquireQuerySlot: NO_QUERY_SLOT });
}
