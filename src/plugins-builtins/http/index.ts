import { DoctorStatus } from '../../types/core.js';
import type { DoctorCheck, QueryRequest, QueryResult, TapRootPlugin } from '../../types/core.js';
import {
  TaprootError,
  accessDenied,
  badInput,
  connectivity,
  misconfiguredDatasource,
  queryTimeoutErr,
} from '../../core/error-classification.js';
import { nowIso } from '../../core/time.js';
import { str } from '../../core/strings.js';

export const HTTP_DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
export const HTTP_HARD_MAX_BODY_BYTES = 5 * 1024 * 1024;
const HTTP_DEFAULT_TIMEOUT_MS = 30_000;

type Datasource = QueryRequest['datasource'];

interface HttpTarget {
  origin: string;
  prefixes: string[];
  maxBodyBytes: number;
}

function targetFrom(ds: Datasource): HttpTarget {
  if (!ds.connection.host) throw misconfiguredDatasource(`http datasource '${ds.name}' has no connection.host.`);
  const ssl = Boolean(ds.connection.ssl);
  const port = ds.connection.port ?? (ssl ? 443 : 80);
  let origin: string;
  try {
    origin = new URL(`${ssl ? 'https' : 'http'}://${ds.connection.host}:${port}`).origin;
  } catch {
    throw misconfiguredDatasource(`http datasource '${ds.name}' has an invalid host or port.`);
  }
  return { origin, prefixes: parsePrefixes(ds), maxBodyBytes: parseMaxBody(ds) };
}

function parsePrefixes(ds: Datasource): string[] {
  const raw = str(ds.resolverHints?.allowPathPrefixes).trim();
  const prefixes = raw.split(',').map((p) => p.trim().replace(/\/+$/, '')).filter(Boolean);
  if (!prefixes.length) {
    throw misconfiguredDatasource(`http datasource '${ds.name}' needs resolverHints.allowPathPrefixes (comma-separated); none set, every request is refused.`);
  }
  for (const p of prefixes) {
    if (!p.startsWith('/') || p.includes('..') || /[?#\\%\s]/.test(p)) {
      throw misconfiguredDatasource(`http datasource '${ds.name}' has an invalid path prefix '${p}'.`);
    }
  }
  return prefixes;
}

function parseMaxBody(ds: Datasource): number {
  const raw = ds.resolverHints?.maxBodyBytes;
  if (raw === undefined || raw === '') return HTTP_DEFAULT_MAX_BODY_BYTES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > HTTP_HARD_MAX_BODY_BYTES) {
    throw misconfiguredDatasource(`http datasource '${ds.name}' maxBodyBytes must be an integer from 1 to ${HTTP_HARD_MAX_BODY_BYTES}.`);
  }
  return n;
}

// Returns the path and query to request. Refuses anything that could leave the
// datasource host or escape the allowed prefixes, before any I/O.
export function checkRequestPath(input: string, prefixes: string[]): { path: string; search: string } {
  const text = input.trim();
  if (!text.startsWith('/') || text.startsWith('//')) {
    throw badInput('http path must start with a single "/" and must not name a host.');
  }
  if (/[#\\\s\u0000-\u001f]/.test(text)) {
    throw badInput('http path has a fragment, backslash, whitespace or control character.');
  }
  const q = text.indexOf('?');
  const path = q === -1 ? text : text.slice(0, q);
  const search = q === -1 ? '' : text.slice(q);
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw badInput('http path has malformed percent-encoding.');
  }
  if (decoded.includes('%')) throw badInput('http path is double-encoded; refused.');
  if (decoded.split('/').some((seg) => seg === '.' || seg === '..')) {
    throw badInput('http path contains a dot segment; refused.');
  }
  if (!prefixes.some((p) => path === p || path.startsWith(`${p}/`))) {
    throw badInput(`http path '${path}' is outside the allowed prefixes (${prefixes.join(', ')}).`);
  }
  return { path, search };
}

function isTimeout(signal: AbortSignal): boolean {
  return signal.aborted && (signal.reason as { name?: string } | undefined)?.name === 'TimeoutError';
}

async function fetchBounded(
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
  maxBytes: number,
): Promise<{ status: number; contentType: string; bytes: number; body: string }> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers, redirect: 'manual', signal });
  } catch (error) {
    if (isTimeout(signal)) throw queryTimeoutErr('http request timed out.');
    if (signal.aborted) throw error;
    throw connectivity(`http request failed: ${str((error as Error)?.message || error)}`);
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined);
    throw badInput(`http redirect refused (HTTP ${res.status}); the plugin does not follow redirects.`);
  }
  if (res.status === 401) {
    await res.body?.cancel().catch(() => undefined);
    throw new TaprootError('AUTH_EXPIRED', 'http 401 unauthorized; check the datasource credentials.');
  }
  if (res.status === 403) {
    await res.body?.cancel().catch(() => undefined);
    throw accessDenied('http 403 forbidden.');
  }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw badInput(`http response exceeds maxBodyBytes (${maxBytes}); refused.`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  try {
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw badInput(`http response exceeds maxBodyBytes (${maxBytes}); refused.`);
        }
        chunks.push(Buffer.from(value));
      }
    }
  } catch (error) {
    if (error instanceof TaprootError) throw error;
    if (isTimeout(signal)) throw queryTimeoutErr('http response read timed out.');
    throw error;
  }
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    bytes: total,
    body: Buffer.concat(chunks).toString('utf8'),
  };
}

export const httpPlugin: TapRootPlugin = {
  manifest: {
    name: 'http',
    capabilities: ['doctor', 'executeRead'],
  },

  async doctor(input): Promise<DoctorCheck[]> {
    try {
      const target = targetFrom(input.datasource);
      return [{
        check: 'http config',
        status: DoctorStatus.Ok,
        detail: `${target.origin}, ${target.prefixes.length} path prefix(es); no request sent`,
      }];
    } catch (error) {
      return [{ check: 'http config', status: DoctorStatus.Fail, detail: str((error as Error).message) }];
    }
  },

  async execute(request, creds): Promise<QueryResult> {
    const startedAt = nowIso();
    const start = Date.now();
    const ds = request.datasource;
    if (!ds.policy.allowRead) throw accessDenied(`datasource '${ds.name}' disallows reads (allowRead=false).`);
    if (request.capability !== 'executeRead') {
      throw badInput(`http plugin is read-only; capability '${request.capability}' refused.`);
    }

    const text = request.query.trim();
    const verbMatch = /^(\S+)\s+(\S+)$/.exec(text);
    if (verbMatch && verbMatch[1]!.toUpperCase() !== 'GET') {
      throw badInput(`http verb '${verbMatch[1]}' not in allow-list; only GET is supported.`);
    }
    const target = targetFrom(ds);
    const { path, search } = checkRequestPath(verbMatch ? verbMatch[2]! : text, target.prefixes);
    const url = new URL(path + search, target.origin);
    if (url.origin !== target.origin) throw badInput('http request would leave the datasource host; refused.');

    const headers: Record<string, string> = { accept: '*/*' };
    if (creds.token) headers.authorization = `Bearer ${creds.token}`;
    const timeoutMs = request.timeoutMs && request.timeoutMs > 0 ? request.timeoutMs : HTTP_DEFAULT_TIMEOUT_MS;
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(request.signal ? [request.signal] : [])]);

    const res = await fetchBounded(url, headers, signal, target.maxBodyBytes);
    return {
      datasource: ds.name,
      plugin: 'http',
      capability: request.capability,
      query: { native: `GET ${path}${search}` },
      result: {
        columns: ['status', 'content_type', 'bytes', 'body'],
        rows: [[res.status, res.contentType, res.bytes, res.body]],
      },
      timings: { startedAt, endedAt: nowIso(), durationMs: Date.now() - start },
      warnings: [],
      classification: 'success',
    };
  },
};
