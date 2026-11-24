import fs from 'node:fs';
import { connect as tlsConnect } from 'node:tls';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { RUNTIME_CONSTANTS } from '../src/core/constants.js';
import { TAPROOT_VERSION } from '../src/core/version.js';
import { mutualTlsClientOptions } from '../src/daemon/transport.js';
import type { HostPort, MutualTlsFiles } from '../src/daemon/transport.js';
import type { QueryRequest } from '../src/types/plugin.js';
import { fakePlugin, interceptExecute } from './helpers/fake-plugin.js';
import { recordEvents, useTlsDaemons } from './helpers/tls-daemon-fixture.js';

const MAX_REQUEST_LINE_CHARS = 1024 * 1024;
const MismatchReplySchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

function requestLine(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ protocolVersion: RUNTIME_CONSTANTS.protocolVersion, clientVersion: TAPROOT_VERSION, requestId: 'r1', method: 'query.execute', params: { datasource: 'qa-fake', query: 'SELECT 1' }, ...overrides })}\n`;
}

describe('daemon over mutual TLS', () => {
  const tls = useTlsDaemons();

  async function rawReply(server: HostPort, clientCertificate: MutualTlsFiles | undefined, payload: string): Promise<string> {
    return new Promise((resolve) => {
      const socket = clientCertificate === undefined
        ? tlsConnect({ ...server, ca: fs.readFileSync(tls.pki.client.caFile), minVersion: 'TLSv1.3' })
        : tlsConnect(mutualTlsClientOptions(clientCertificate, server));
      let reply = '';
      socket.setEncoding('utf8');
      socket.on('secureConnect', () => {
        socket.write(payload);
      });
      socket.on('data', (chunk: string) => {
        reply += chunk;
        if (reply.includes('\n')) {
          socket.end();
        }
      });
      socket.on('error', () => {
        socket.destroy();
      });
      socket.on('close', () => {
        resolve(reply);
      });
    });
  }

  it('answers a client whose certificate comes from its CA', async () => {
    // arrange
    const server = await tls.startDaemon();

    // act
    const res = await tls.readOk(server);

    // assert
    expect(res).toMatchObject({ ok: true, data: { columns: ['ok'], rows: [[1]] } });
  });

  it('sends nothing back to a client without a certificate', async () => {
    // arrange
    const server = await tls.startDaemon();

    // act
    const reply = await rawReply(server, undefined, requestLine());

    // assert
    expect(reply).toBe('');
  });

  it('closes the connection when a request line grows past 1 MiB and reports the drop', async () => {
    // arrange
    const { events, log } = recordEvents();
    const server = await tls.startDaemon({ log });

    // act
    const reply = await rawReply(server, tls.pki.client, 'x'.repeat(MAX_REQUEST_LINE_CHARS + 1));

    // assert
    expect(reply).toBe('');
    expect(events).toStrictEqual([{ requestDropped: 'request line over 1048576 characters', peer: '127.0.0.1' }]);
  });

  it('tells a client of another version to match versions and keeps serving', async () => {
    // arrange
    const server = await tls.startDaemon();

    // act
    const mismatchReply = await rawReply(server, tls.pki.client, requestLine({ clientVersion: '0.0.0' }));
    const mismatch = MismatchReplySchema.parse(JSON.parse(mismatchReply));
    const next = await tls.readOk(server);

    // assert
    expect(mismatch.error).toStrictEqual({ code: 'DAEMON_VERSION_MISMATCH', message: `this daemon runs ${TAPROOT_VERSION} and the client runs 0.0.0; run the same version on both sides.` });
    expect(next.ok).toBe(true);
  });

  it('refuses a client certificate from another CA', async () => {
    // arrange
    const server = await tls.startDaemon();
    const strangerWithOurCa = { ...tls.otherPki.client, caFile: tls.pki.client.caFile };

    // act
    const call = tls.readOk(server, strangerWithOurCa);

    // assert
    await expect(call).rejects.toBeInstanceOf(Error);
  });

  it('keeps the client from talking to a daemon whose certificate comes from another CA', async () => {
    // arrange
    const execute = vi.fn<(request: QueryRequest) => void>();
    const impostor = await tls.startDaemon({ files: { ...tls.otherPki.daemon, caFile: tls.pki.client.caFile }, plugin: interceptExecute(fakePlugin(), execute) });

    // act
    const call = tls.readOk(impostor);

    // assert
    await expect(call).rejects.toBeInstanceOf(Error);
    expect(execute).not.toHaveBeenCalled();
  });

  it('fills env and service from the profile of the datasource a client names', async () => {
    // arrange
    const server = await tls.startDaemon();

    // act
    const res = await tls.readOk(server);

    // assert
    expect(res.meta.resolved).toMatchObject({ env: 'qa', service: 'fake' });
  });

  it('refuses a reload interval that is not positive', async () => {
    // act
    const start = tls.startDaemon({ reloadMs: 0 });

    // assert
    await expect(start).rejects.toThrow('BAD_INPUT: listen.reloadMs must be a positive number of milliseconds, got 0.');
  });

  it('answers a method it was not given as unknown', async () => {
    // arrange
    const server = await tls.startDaemon();

    // act
    const res = await tls.call(server, 'daemon.stop', {});

    // assert
    expect(res.error?.code).toBe('UNKNOWN_METHOD');
  });
});

describe('query request shaper', () => {
  const tls = useTlsDaemons();

  it('runs the request the shaper returns', async () => {
    // arrange
    const execute = vi.fn<(request: QueryRequest) => void>();
    const server = await tls.startDaemon({
      plugin: interceptExecute(fakePlugin(), execute),
      query: { shapeRequest: (request) => ({ ...request, allowMutate: false }) },
    });

    // act
    const res = await tls.call(server, 'query.execute', { datasource: 'qa-fake', query: 'DELETE FROM orders', allowMutate: true });

    // assert
    expect(res.error?.message).toContain('Mutating query detected');
    expect(execute).not.toHaveBeenCalled();
  });

  it('caps the rows at the maxRows the shaper sets, whatever the client sent', async () => {
    // arrange
    const server = await tls.startDaemon({
      plugin: fakePlugin({ rows: [[1], [2], [3]] }),
      query: { shapeRequest: (request) => ({ ...request, maxRows: 2 }) },
    });

    // act
    const res = await tls.call(server, 'query.execute', { datasource: 'qa-fake', query: 'SELECT ok FROM t', maxRows: 1000 });

    // assert
    expect(res.data).toMatchObject({ rows: [[1], [2]], truncated: true });
  });
});
