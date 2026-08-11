import { RUNTIME_CONSTANTS } from '../core/constants.js';
import { exitCodeForClass } from '../core/exit-codes.js';
import { printJsonPluck, printJsonStderr, renderSchemaContextFooter, renderTableSmart, respondErr, rowToObject, trimQueryJsonEnvelope } from '../core/output.js';
import { renderQueryMemoryTty } from '../core/query-memory.js';
import { str } from '../core/strings.js';
import { rpcCall } from '../daemon/client.js';
import { RpcMethod } from '../daemon/types.js';
import type { QueryEnv } from './query-types.js';

export type DaemonOutcome = 'handled' | 'fallback';

export async function runDaemonQuery(env: QueryEnv): Promise<DaemonOutcome> {
  const { ctx, opts, progress, logVerbose, timeoutMs, allowDiscovery } = env;
  try {
    const rpc = await rpcCall({
      timeoutMs: Math.max(RUNTIME_CONSTANTS.rpc.requestTimeoutMs, timeoutMs + 1000),
      method: RpcMethod.QueryExecute,
      params: {
        datasource: opts.datasource,
        env: opts.env,
        service: opts.service,
        namespace: opts.namespace,
        intent: opts.intent,
        reason: opts.reason,
        query: opts.query,
        allowDiscovery,
        allowMutate: Boolean(opts.allowMutate),
        allowPartitionScan: Boolean(opts.allowPartitionScan),
        allowSchemaIntrospection: Boolean(opts.allowSchemaIntrospection),
        rowsObject: Boolean(opts.rowsObject),
        timeoutMs,
        tz: opts.tz,
        param: opts.param || [],
        proto: opts.proto,
        protoRoot: opts.protoRoot,
        allowFlush: Boolean(opts.allowFlush),
        requestJson: opts.requestJson,
        skipProtoValidate: Boolean(opts.skipProtoValidate),
      },
    });
    if (rpc.ok) {
      const columns = (rpc.data?.columns as string[]) || [];
      const rows = (rpc.data?.rows as unknown[]) || [];
      const warnings = (rpc.data?.warnings as string[]) || [];
      if (ctx.jsonMode) {
        printJsonPluck(
          trimQueryJsonEnvelope({
            ok: true,
            data: rpc.data || {},
            meta: { ...(rpc.meta || {}), requestId: rpc.requestId },
          }),
          opts.pluck ? String(opts.pluck) : undefined,
        );
      } else {
        progress.succeed(`query complete (${rows.length} rows)`);
        if (warnings.length) {
          progress.warn(`warnings: ${warnings.join(' | ')}`);
        }
        logVerbose(
          `daemon request=${rpc.requestId} session=${rpc.meta?.sessionId || 'n/a'} run=${rpc.meta?.runId || 'n/a'}`,
        );
        console.log(renderTableSmart(rows.map((r) => rowToObject(columns, r)), { full: Boolean(opts.full) }));
        const daemonFooter = renderSchemaContextFooter((rpc.meta as any)?.schemaContext);
        if (daemonFooter) console.log(daemonFooter);
        const renderedMemory = renderQueryMemoryTty(rpc.meta?.queryMemory || (rpc.data?.queryMemory as any));
        if (renderedMemory) console.log(renderedMemory);
      }
      return 'handled';
    }
    const code = rpc.error?.code || 'GENERIC';
    const message = rpc.error?.message || 'daemon query failed';
    if (ctx.jsonMode) {
      const meta = { ...(rpc.meta || {}), requestId: rpc.requestId };
      if (opts.pluck) {
        printJsonStderr({ ok: false, error: { code, message, details: rpc.error?.details }, meta });
      } else {
        respondErr(code, message, rpc.error?.details, meta);
      }
      process.exitCode = exitCodeForClass(code);
      return 'handled';
    }
    throw new Error(`${code}: ${message}`);
  } catch (error) {
    const msg = str((error as Error).message);
    if (!/(ENOENT|ECONNREFUSED|EPIPE|socket hang up)/i.test(msg)) {
      progress.fail('daemon query failed');
      throw error;
    }
    progress.update('daemon unavailable, falling back to direct mode');
    logVerbose(`daemon RPC unavailable (${msg})`);
    return 'fallback';
  }
}
