import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { globToRegExp, parseVerb, rabbitmqPlugin, RABBITMQ_MAX_ROWS } from '../src/plugins-builtins/rabbitmq/index.js';
import { TaprootError } from '../src/core/error-classification.js';
import { DoctorStatus, type DatasourceProfile, type QueryRequest } from '../src/types/core.js';

const PASSWORD_CANARY = 'canary-pass-91c2';
const QUEUES = [
  { name: 'orders.created', messages: 5, messages_ready: 3, messages_unacknowledged: 2, consumers: 1, state: 'running' },
  { name: 'orders.paid', messages: 0, messages_ready: 0, messages_unacknowledged: 0, consumers: 0, state: 'idle' },
  { name: 'billing.retry', messages: 9, messages_ready: 9, messages_unacknowledged: 0, consumers: 2, state: 'running' },
];

let server: http.Server;
let port: number;
let hits: string[] = [];
let lastAuth: string | undefined;

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? '';
    hits.push(url);
    lastAuth = req.headers.authorization;
    if (url === '/api/whoami') return send(res, 200, { name: 'reader' });
    if (url === '/api/vhosts/%2F') return send(res, 200, { name: '/' });
    if (url === '/api/vhosts/nope') return send(res, 404, { error: 'Object Not Found' });
    if (url === '/api/queues/%2F') return send(res, 200, QUEUES);
    if (url === '/api/queues/many') return send(res, 200, Array.from({ length: RABBITMQ_MAX_ROWS + 5 }, (_, i) => ({ name: `q${i}` })));
    if (url === '/api/queues/%2F/orders.created') return send(res, 200, QUEUES[0]);
    if (url === '/api/queues/%2F/orders.created/bindings') {
      return send(res, 200, [
        { source: '', routing_key: 'orders.created', arguments: {} },
        { source: 'events', routing_key: 'order.#', arguments: { 'x-match': 'any' } },
      ]);
    }
    if (url === '/api/queues/%2F/gone') return send(res, 404, { error: 'Object Not Found' });
    if (url === '/api/queues/%2F/locked') return send(res, 401, { error: 'Unauthorized' });
    if (url === '/api/queues/%2F/forbidden') return send(res, 403, { error: 'Forbidden' });
    if (url === '/api/queues/%2F/moved') {
      res.writeHead(302, { location: '/api/queues/%2F/orders.paid' });
      return res.end();
    }
    if (url === '/api/queues/%2F/huge') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024) });
      return res.end('x'.repeat(2 * 1024 * 1024));
    }
    if (url === '/api/queues/%2F/slow') {
      setTimeout(() => send(res, 200, QUEUES[0]), 2000);
      return;
    }
    send(res, 404, { error: 'Object Not Found' });
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

function ds(allowRead = true, hints: Record<string, string> = {}): DatasourceProfile {
  return {
    name: 'unit-rabbitmq',
    kind: 'rabbitmq',
    connection: { host: '127.0.0.1', port },
    credentialRef: 'unit-rabbitmq',
    policy: { allowRead, allowMutate: false, allowedCapabilities: ['executeRead'] },
    resolverHints: hints,
    updatedAt: new Date().toISOString(),
    confidence: 0.9,
  };
}

function req(query: string, over: Partial<QueryRequest> = {}): QueryRequest {
  return { datasource: ds(), query, capability: 'executeRead', sessionTimeZone: 'UTC', signal: undefined, ...over };
}

const CREDS = { user: 'reader', password: PASSWORD_CANARY };

async function errorOf(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    return {
      code: error instanceof TaprootError ? error.code : 'UNTYPED',
      message: (error as Error).message,
    };
  }
  return { code: 'NO_ERROR', message: '' };
}

describe('rabbitmq plugin', () => {
  it('lists queues for the vhost, filtering the glob in memory and sending basic auth', async () => {
    const result = await rabbitmqPlugin.execute!(req('queues MATCH orders.*'), CREDS);

    expect(result.result.columns).toEqual(['name', 'messages', 'messages_ready', 'messages_unacknowledged', 'consumers', 'state']);
    expect(result.result.rows.map((r) => r[0])).toEqual(['orders.created', 'orders.paid']);
    expect(result.result.rows[0]?.[1]).toBe(5);
    expect(hits).toEqual(['/api/queues/%2F']);
    expect(lastAuth).toBe(`Basic ${Buffer.from(`reader:${PASSWORD_CANARY}`).toString('base64')}`);
  });

  it('returns one queue depth row, encoding the name in the path', async () => {
    const result = await rabbitmqPlugin.execute!(req('queue orders.created'), CREDS);

    expect(result.result.rows).toEqual([['orders.created', 5, 3, 2, 1, 'running']]);
    expect(hits).toEqual(['/api/queues/%2F/orders.created']);
  });

  it('lists bindings with the default exchange shown as (default) and arguments as a flag', async () => {
    const result = await rabbitmqPlugin.execute!(req('bindings orders.created'), CREDS);

    expect(result.result.columns).toEqual(['exchange', 'routing_key', 'arguments_present']);
    expect(result.result.rows).toEqual([
      ['(default)', 'orders.created', false],
      ['events', 'order.#', true],
    ]);
  });

  it('refuses purge, get, publish and malformed usage before any request is made', async () => {
    for (const q of ['purge orders.created', 'get orders.created', 'publish orders.created', 'queues extra', 'queue']) {
      const err = await errorOf(rabbitmqPlugin.execute!(req(q), CREDS));
      expect(err.code, q).toBe('BAD_INPUT');
    }
    expect(hits).toEqual([]);
  });

  it('refuses a mutate capability without I/O', async () => {
    const err = await errorOf(rabbitmqPlugin.execute!(req('queues', { capability: 'executeMutate' }), CREDS));

    expect(err.code).toBe('BAD_INPUT');
    expect(hits).toEqual([]);
  });

  it('keeps a hostile queue name inside one path segment', async () => {
    const err = await errorOf(rabbitmqPlugin.execute!(req('queue ../../api/whoami'), CREDS));

    expect(err.code).toBe('BAD_INPUT');
    expect(hits).toEqual(['/api/queues/%2F/..%2F..%2Fapi%2Fwhoami']);
  });

  it('maps an unknown queue to BAD_INPUT', async () => {
    const err = await errorOf(rabbitmqPlugin.execute!(req('queue gone'), CREDS));

    expect(err.code).toBe('BAD_INPUT');
    expect(err.message).toContain("queue 'gone' not found");
  });

  it('maps 401 to AUTH_EXPIRED without echoing the password', async () => {
    const err = await errorOf(rabbitmqPlugin.execute!(req('queue locked'), CREDS));

    expect(err.code).toBe('AUTH_EXPIRED');
    expect(err.message).not.toContain(PASSWORD_CANARY);
  });

  it('maps 403 to ACCESS_DENIED', async () => {
    const err = await errorOf(rabbitmqPlugin.execute!(req('queue forbidden'), CREDS));

    expect(err.code).toBe('ACCESS_DENIED');
  });

  it('refuses a redirect and does not follow it', async () => {
    const err = await errorOf(rabbitmqPlugin.execute!(req('queue moved'), CREDS));

    expect(err.code).toBe('BAD_INPUT');
    expect(hits).toEqual(['/api/queues/%2F/moved']);
  });

  it('refuses a response over the body cap', async () => {
    const err = await errorOf(rabbitmqPlugin.execute!(req('queue huge'), CREDS));

    expect(err.code).toBe('BAD_INPUT');
  });

  it('maps a timeout to QUERY_TIMEOUT', async () => {
    const err = await errorOf(rabbitmqPlugin.execute!(req('queue slow', { timeoutMs: 100 }), CREDS));

    expect(err.code).toBe('QUERY_TIMEOUT');
  });

  it('refuses reads when the datasource policy disallows them', async () => {
    const err = await errorOf(rabbitmqPlugin.execute!(req('queues', { datasource: ds(false) }), CREDS));

    expect(err.code).toBe('ACCESS_DENIED');
    expect(hits).toEqual([]);
  });

  it('caps queue rows at the row limit and sets the truncated warning', async () => {
    const result = await rabbitmqPlugin.execute!(req('queues', { datasource: ds(true, { vhost: 'many' }) }), CREDS);

    expect(result.result.rows).toHaveLength(RABBITMQ_MAX_ROWS);
    expect(result.warnings).toEqual(['truncated']);
  });

  it('matches globs by whole name only', () => {
    const re = globToRegExp('q*');
    expect(re.test('q1')).toBe(true);
    expect(re.test('xq1')).toBe(false);
  });

  it('parses verbs strictly', () => {
    expect(parseVerb('queues')).toEqual({ verb: 'queues' });
    expect(parseVerb('queues MATCH a*')).toEqual({ verb: 'queues', glob: 'a*' });
    expect(() => parseVerb('queues MATCH')).toThrow(TaprootError);
  });

  it('doctor checks whoami and vhost and sends no message read', async () => {
    const ok = await rabbitmqPlugin.doctor!({ datasource: ds(), credentials: CREDS });
    const missing = await rabbitmqPlugin.doctor!({ datasource: ds(true, { vhost: 'nope' }), credentials: CREDS });

    expect(ok[0]?.status).toBe(DoctorStatus.Ok);
    expect(missing[0]?.status).toBe(DoctorStatus.Fail);
    expect(hits.some((h) => h.includes('/get') || h.includes('publish'))).toBe(false);
  });
});
