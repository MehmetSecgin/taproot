import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { MutualTlsFiles } from '../src/daemon/transport.js';
import { recordEvents, useTlsDaemons } from './helpers/tls-daemon-fixture.js';
import type { StartedTlsDaemon } from './helpers/tls-daemon-fixture.js';

function copyOf(files: MutualTlsFiles): MutualTlsFiles {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-served-'));
  const copy = (source: string): string => {
    const target = path.join(directory, path.basename(source));
    fs.copyFileSync(source, target);
    return target;
  };
  return { caFile: copy(files.caFile), certFile: copy(files.certFile), keyFile: copy(files.keyFile) };
}

describe('daemon certificate rotation', () => {
  const tls = useTlsDaemons();

  async function rotatableDaemon(): Promise<{ server: StartedTlsDaemon; served: MutualTlsFiles; events: Record<string, unknown>[] }> {
    const served = copyOf(tls.pki.daemon);
    const { events, log } = recordEvents();
    const server = await tls.startDaemon({ files: served, reloadMs: 25, log });
    return { server, served, events };
  }

  it('serves a rotated certificate without a restart', async () => {
    // arrange
    const { server, served, events } = await rotatableDaemon();

    // act
    fs.copyFileSync(tls.otherPki.daemon.caFile, served.caFile);
    fs.copyFileSync(tls.otherPki.daemon.certFile, served.certFile);
    fs.copyFileSync(tls.otherPki.daemon.keyFile, served.keyFile);
    await vi.waitFor(() => {
      expect(events).toContainEqual({ tlsReload: 'applied' });
    });

    // assert
    await expect(tls.readSucceeds(server, tls.otherPki.client)).resolves.toBe(true);
    await expect(tls.readSucceeds(server, tls.pki.client)).resolves.toBe(false);
  });

  it('keeps serving the old certificate while a rotation is half written', async () => {
    // arrange
    const { server, served, events } = await rotatableDaemon();

    // act
    fs.copyFileSync(tls.otherPki.daemon.certFile, served.certFile);
    await vi.waitFor(() => {
      expect(events.some((event) => event.tlsReload === 'failed')).toBe(true);
    });

    // assert
    await expect(tls.readSucceeds(server, tls.pki.client)).resolves.toBe(true);
    expect(events).not.toContainEqual({ tlsReload: 'applied' });
  });
});
