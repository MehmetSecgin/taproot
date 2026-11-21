import { DoctorStatus } from '../../types/core.js';
import type { DoctorCheck, QueryRequest, QueryResult, TapRootPlugin } from '../../types/core.js';
import {
  TaprootError,
  accessDenied,
  badInput,
  classifyExecutorDoctorCode,
  connectivity,
  misconfiguredDatasource,
  queryTimeoutErr,
} from '../../core/error-classification.js';
import { nowIso } from '../../core/time.js';
import { str } from '../../core/strings.js';

const RABBITMQ_DEFAULT_PORT = 15672;
const MAX_BODY_BYTES = 1024 * 1024;
export const RABBITMQ_MAX_ROWS = 200;
const DEFAULT_TIMEOUT_MS = 30_000;

type Datasource = QueryRequest['datasource'];

type Verb =
  | { verb: 'queues'; glob?: string }
  | { verb: 'queue' | 'bindings'; name: string };

// Parses the whole query line. Only the verbs below exist; anything else is refused.
export function parseVerb(query: string): Verb {
  const parts = query.trim().split(/\s+/).filter(Boolean);
  const verb = (parts[0] ?? '').toLowerCase();
  if (verb === 'queues') {
    if (parts.length === 1) return { verb };
    if (parts.length === 3 && parts[1]!.toUpperCase() === 'MATCH') return { verb, glob: parts[2] };
    throw badInput('usage: queues [MATCH <glob>]');
  }
  if (verb === 'queue' || verb === 'bindings') {
    if (parts.length !== 2) throw badInput(`usage: ${verb} <queue-name>`);
    return { verb, name: parts[1]! };
  }
  throw badInput(`rabbitmq verb '${parts[0] ?? ''}' not in allow-list (queues, queue, bindings).`);
}

export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function originOf(ds: Datasource): string {
  if (!ds.connection.host) throw misconfiguredDatasource(`rabbitmq datasource '${ds.name}' has no connection.host.`);
  const ssl = Boolean(ds.connection.ssl);
  const port = ds.connection.port ?? RABBITMQ_DEFAULT_PORT;
  try {
    return new URL(`${ssl ? 'https' : 'http'}://${ds.connection.host}:${port}`).origin;
  } catch {
    throw misconfiguredDatasource(`rabbitmq datasource '${ds.name}' has an invalid host or port.`);
  }
}

// vhost is encoded for the path: "/" becomes "%2F", so it cannot add path segments.
function vhostSegment(ds: Datasource): string {
  return encodeURIComponent(str(ds.resolverHints?.vhost) || '/');
}

function basicAuth(creds: Record<string, string>): string | undefined {
  if (creds.user === undefined && creds.password === undefined) return undefined;
  return `Basic ${Buffer.from(`${creds.user ?? ''}:${creds.password ?? ''}`).toString('base64')}`;
}

function isTimeout(signal: AbortSignal): boolean {
  return signal.aborted && (signal.reason as { name?: string } | undefined)?.name === 'TimeoutError';
}

// Every response goes through here: GET only, no redirects, bounded body, timeout.
async function getJson(
  origin: string,
  path: string,
  auth: string | undefined,
  signal: AbortSignal,
): Promise<{ status: number; json: unknown }> {
  const url = new URL(path, origin);
  if (url.origin !== origin) throw badInput('rabbitmq request would leave the datasource host; refused.');
  const headers: Record<string, string> = { accept: 'application/json' };
  if (auth) headers.authorization = auth;
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers, redirect: 'manual', signal });
  } catch (error) {
    if (isTimeout(signal)) throw queryTimeoutErr('rabbitmq management request timed out.');
    if (signal.aborted) throw error;
    throw connectivity(`rabbitmq management request failed: ${str((error as Error)?.message || error)}`);
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined);
    throw badInput(`rabbitmq redirect refused (HTTP ${res.status}); the plugin does not follow redirects.`);
  }
  if (res.status === 401) {
    await res.body?.cancel().catch(() => undefined);
    throw new TaprootError('AUTH_EXPIRED', 'rabbitmq management API returned 401; check the datasource credentials.');
  }
  if (res.status === 403) {
    await res.body?.cancel().catch(() => undefined);
    throw accessDenied('rabbitmq management API returned 403 for this resource.');
  }
  if (res.status === 404) {
    await res.body?.cancel().catch(() => undefined);
    return { status: 404, json: undefined };
  }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw badInput(`rabbitmq response exceeds ${MAX_BODY_BYTES} bytes; refused.`);
  }
  let text: string;
  try {
    text = await res.text();
  } catch (error) {
    if (isTimeout(signal)) throw queryTimeoutErr('rabbitmq management response timed out.');
    throw error;
  }
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw badInput(`rabbitmq response exceeds ${MAX_BODY_BYTES} bytes; refused.`);
  if (res.status < 200 || res.status >= 300) throw new Error(`rabbitmq management API returned HTTP ${res.status}`);
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    throw badInput('rabbitmq management API returned a non-JSON body; check that the port is the management port.');
  }
}

interface QueueJson {
  name?: string;
  messages?: number;
  messages_ready?: number;
  messages_unacknowledged?: number;
  consumers?: number;
  state?: string;
}

function queueRow(q: QueueJson): unknown[] {
  return [q.name ?? null, q.messages ?? null, q.messages_ready ?? null, q.messages_unacknowledged ?? null, q.consumers ?? null, q.state ?? null];
}

export const rabbitmqPlugin: TapRootPlugin = {
  manifest: {
    name: 'rabbitmq',
    capabilities: ['doctor', 'executeRead'],
  },

  async doctor(input): Promise<DoctorCheck[]> {
    const ds = input.datasource;
    const signal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
    try {
      const origin = originOf(ds);
      const auth = basicAuth(input.credentials);
      await getJson(origin, '/api/whoami', auth, signal);
      const vhost = await getJson(origin, `/api/vhosts/${vhostSegment(ds)}`, auth, signal);
      if (vhost.status === 404) {
        return [{ check: 'rabbitmq vhost', status: DoctorStatus.Fail, detail: 'vhost not found', code: 'executor_unknown_target' }];
      }
      return [{ check: 'rabbitmq management', status: DoctorStatus.Ok, detail: 'whoami and vhost reachable; no message read' }];
    } catch (error) {
      const detail = str((error as Error).message).slice(0, 400);
      return [{ check: 'rabbitmq management', status: DoctorStatus.Fail, detail, code: classifyExecutorDoctorCode(detail) }];
    }
  },

  async execute(request, creds): Promise<QueryResult> {
    const startedAt = nowIso();
    const start = Date.now();
    const ds = request.datasource;
    if (!ds.policy.allowRead) throw accessDenied(`datasource '${ds.name}' disallows reads (allowRead=false).`);
    if (request.capability !== 'executeRead') {
      throw badInput(`rabbitmq plugin is read-only; capability '${request.capability}' refused.`);
    }
    const parsed = parseVerb(request.query);
    const origin = originOf(ds);
    const vhost = vhostSegment(ds);
    const auth = basicAuth(creds);
    const timeoutMs = request.timeoutMs && request.timeoutMs > 0 ? request.timeoutMs : DEFAULT_TIMEOUT_MS;
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(request.signal ? [request.signal] : [])]);

    const warnings: string[] = [];
    let columns: string[];
    let rows: unknown[][];

    if (parsed.verb === 'queues') {
      const { json } = await getJson(origin, `/api/queues/${vhost}`, auth, signal);
      const all = Array.isArray(json) ? (json as QueueJson[]) : [];
      const re = parsed.glob === undefined ? undefined : globToRegExp(parsed.glob);
      const matched = all.filter((q) => re === undefined || re.test(q.name ?? ''));
      if (matched.length > RABBITMQ_MAX_ROWS) warnings.push('truncated');
      columns = ['name', 'messages', 'messages_ready', 'messages_unacknowledged', 'consumers', 'state'];
      rows = matched.slice(0, RABBITMQ_MAX_ROWS).map(queueRow);
    } else if (parsed.verb === 'queue') {
      const { status, json } = await getJson(origin, `/api/queues/${vhost}/${encodeURIComponent(parsed.name)}`, auth, signal);
      if (status === 404) throw badInput(`queue '${parsed.name}' not found in vhost.`);
      columns = ['name', 'messages', 'messages_ready', 'messages_unacknowledged', 'consumers', 'state'];
      rows = [queueRow(json as QueueJson)];
    } else {
      const { status, json } = await getJson(origin, `/api/queues/${vhost}/${encodeURIComponent(parsed.name)}/bindings`, auth, signal);
      if (status === 404) throw badInput(`queue '${parsed.name}' not found in vhost.`);
      const bindings = Array.isArray(json) ? (json as Array<{ source?: string; routing_key?: string; arguments?: object }>) : [];
      if (bindings.length > RABBITMQ_MAX_ROWS) warnings.push('truncated');
      columns = ['exchange', 'routing_key', 'arguments_present'];
      rows = bindings.slice(0, RABBITMQ_MAX_ROWS).map((b) => [
        b.source || '(default)',
        b.routing_key ?? '',
        Object.keys(b.arguments ?? {}).length > 0,
      ]);
    }

    return {
      datasource: ds.name,
      plugin: 'rabbitmq',
      capability: request.capability,
      query: { native: request.query },
      result: { columns, rows },
      timings: { startedAt, endedAt: nowIso(), durationMs: Date.now() - start },
      warnings,
      classification: 'success',
    };
  },
};
