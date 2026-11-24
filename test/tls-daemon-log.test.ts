import { describe, expect, it, vi } from 'vitest';
import { recordEvents, useTlsDaemons } from './helpers/tls-daemon-fixture.js';
import type { StartedTlsDaemon } from './helpers/tls-daemon-fixture.js';

describe('daemon log', () => {
  const tls = useTlsDaemons();

  async function loggedDaemon(): Promise<{ server: StartedTlsDaemon; events: Record<string, unknown>[] }> {
    const { events, log } = recordEvents();
    const server = await tls.startDaemon({ log });
    return { server, events };
  }

  it('reports a client whose certificate comes from another CA', async () => {
    // arrange
    const { server, events } = await loggedDaemon();
    const strangerWithOurCa = { ...tls.otherPki.client, caFile: tls.pki.client.caFile };

    // act
    await expect(tls.readOk(server, strangerWithOurCa)).rejects.toBeInstanceOf(Error);

    // assert
    await vi.waitFor(() => {
      expect(events.map((event) => typeof event.tlsClientError)).toStrictEqual(['string']);
    });
  });

  it('reports a request it answered with an error', async () => {
    // arrange
    const { server, events } = await loggedDaemon();

    const anyNumber: unknown = expect.any(Number);

    // act
    const res = await tls.call(server, 'schema.read', { datasource: 'qa-nope' });

    // assert
    expect(events).toStrictEqual([{
      requestFailed: 'schema.read',
      code: 'UNKNOWN_DATASOURCE',
      message: res.error?.message,
      requestId: res.requestId,
      durationMs: anyNumber,
      peer: '127.0.0.1',
    }]);
  });

  it('stays quiet for a request it answered', async () => {
    // arrange
    const { server, events } = await loggedDaemon();

    // act
    await tls.readOk(server);

    // assert
    expect(events).toStrictEqual([]);
  });
});
