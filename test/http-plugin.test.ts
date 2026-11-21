import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { httpPlugin, checkRequestPath } from '../src/plugins-builtins/http/index.js';
import { TaprootError } from '../src/core/error-classification.js';
import { DoctorStatus, type DatasourceProfile, type QueryRequest } from '../src/types/core.js';

const TOKEN_CANARY = 'canary-token-7f3a';

let server: http.Server;
let port: number;
let hits: string[] = [];
let lastAuth: string | undefined;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    lastAuth = req.headers.authorization;
    const url = req.url ?? '';
    if (url.startsWith('/api/v1/redirect')) {
      res.writeHead(302, { location: '/api/v1/other' });
      res.end();
      return;
    }
    if (url.startsWith('/api/v1/slow')) {
      setTimeout(() => { res.writeHead(200); res.end('late'); }, 2000);
      return;
    }
    if (url.startsWith('/api/v1/unauthorized')) {
      res.writeHead(401);
      res.end('nope');
      return;
    }
    if (url.startsWith('/api/v1/big')) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('x'.repeat(1000));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, url }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  hits = [];
  lastAuth = undefined;
});

function ds(hints: Record<string, string> = { allowPathPrefixes: '/api/v1' }, allowRead = true): DatasourceProfile {
  return {
    name: 'unit-http',
    kind: 'http',
    connection: { host: '127.0.0.1', port },
    credentialRef: 'unit-http',
    policy: { allowRead, allowMutate: false, allowedCapabilities: ['executeRead'] },
    resolverHints: hints,
    updatedAt: new Date().toISOString(),
    confidence: 0.9,
  };
}

function req(query: string, over: Partial<QueryRequest> = {}): QueryRequest {
  return {
    datasource: ds(),
    query,
    capability: 'executeRead',
    sessionTimeZone: 'UTC',
    signal: undefined,
    ...over,
  };
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof TaprootError ? error.code : `UNTYPED:${(error as Error).message}`;
  }
  return 'NO_ERROR';
}

describe('http plugin', () => {
  it('returns status, content type, size and body for an allowed GET, sending the bearer token', async () => {
    const result = await httpPlugin.execute!(req('GET /api/v1/items?limit=2'), { token: TOKEN_CANARY });

    expect(result.result.columns).toEqual(['status', 'content_type', 'bytes', 'body']);
    expect(result.result.rows[0]?.[0]).toBe(200);
    expect(String(result.result.rows[0]?.[3])).toContain('/api/v1/items?limit=2');
    expect(hits).toEqual(['/api/v1/items?limit=2']);
    expect(lastAuth).toBe(`Bearer ${TOKEN_CANARY}`);
  });

  it('allows a path equal to a prefix or below it, and refuses a sibling that only shares the text', () => {
    expect(checkRequestPath('/api/v1', ['/api/v1']).path).toBe('/api/v1');
    expect(checkRequestPath('/api/v1/x', ['/api/v1']).path).toBe('/api/v1/x');
    expect(() => checkRequestPath('/api/v10', ['/api/v1'])).toThrow(/outside the allowed prefixes/);
  });

  it.each([
    ['/api/v1/../admin'],
    ['/api/v1/%2e%2e/admin'],
    ['/api/v1/%252e%252e/admin'],
    ['//evil.example/api/v1/x'],
    ['http://other.example/api/v1/x'],
    ['/api/v1/x#frag'],
    ['/api/v1/x y'],
  ])('refuses %s before any request is made', async (path) => {
    const code = await errorCode(httpPlugin.execute!(req(`GET ${path}`), {}));

    expect(code).toBe('BAD_INPUT');
    expect(hits).toEqual([]);
  });

  it('refuses a non-GET verb with no request made', async () => {
    const code = await errorCode(httpPlugin.execute!(req('POST /api/v1/items'), {}));

    expect(code).toBe('BAD_INPUT');
    expect(hits).toEqual([]);
  });

  it('refuses a mutate capability without any I/O', async () => {
    const code = await errorCode(httpPlugin.execute!(req('GET /api/v1/x', { capability: 'executeMutate' }), {}));

    expect(code).toBe('BAD_INPUT');
    expect(hits).toEqual([]);
  });

  it('refuses every request when the allowlist is empty, as a misconfigured datasource', async () => {
    const code = await errorCode(httpPlugin.execute!(req('GET /api/v1/x', { datasource: ds({ allowPathPrefixes: '' }) }), {}));

    expect(code).toBe('MISCONFIGURED_DATASOURCE');
    expect(hits).toEqual([]);
  });

  it('refuses a redirect and does not follow it', async () => {
    const code = await errorCode(httpPlugin.execute!(req('GET /api/v1/redirect'), {}));

    expect(code).toBe('BAD_INPUT');
    expect(hits).toEqual(['/api/v1/redirect']);
  });

  it('refuses a body over maxBodyBytes', async () => {
    const big = req('GET /api/v1/big', { datasource: ds({ allowPathPrefixes: '/api/v1', maxBodyBytes: '100' }) });

    const code = await errorCode(httpPlugin.execute!(big, {}));

    expect(code).toBe('BAD_INPUT');
  });

  it('maps a timeout to QUERY_TIMEOUT', async () => {
    const code = await errorCode(httpPlugin.execute!(req('GET /api/v1/slow', { timeoutMs: 100 }), {}));

    expect(code).toBe('QUERY_TIMEOUT');
  });

  it('maps 401 to AUTH_EXPIRED and keeps the token out of the message', async () => {
    let message = '';
    try {
      await httpPlugin.execute!(req('GET /api/v1/unauthorized'), { token: TOKEN_CANARY });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/^AUTH_EXPIRED:/);
    expect(message).not.toContain(TOKEN_CANARY);
  });

  it('refuses reads on a datasource whose policy disallows them', async () => {
    const code = await errorCode(httpPlugin.execute!(req('GET /api/v1/x', { datasource: ds(undefined, false) }), {}));

    expect(code).toBe('ACCESS_DENIED');
    expect(hits).toEqual([]);
  });

  it('doctor reports config only and sends no request', async () => {
    const ok = await httpPlugin.doctor!({ datasource: ds(), credentials: {} });
    const bad = await httpPlugin.doctor!({ datasource: ds({ allowPathPrefixes: '' }), credentials: {} });

    expect(ok[0]?.status).toBe(DoctorStatus.Ok);
    expect(bad[0]?.status).toBe(DoctorStatus.Fail);
    expect(hits).toEqual([]);
  });
});
