import fs from 'node:fs';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import tls from 'node:tls';
import { badInput } from '../core/taproot-error.js';
import type { DaemonEndpoint } from './methods/types.js';
import type { DaemonListen, DaemonLog } from './server.js';
import { mutualTlsServerOptions, readTlsMaterial, tlsFingerprint } from './transport.js';
import type { MutualTlsFiles } from './transport.js';
import { errorText } from '../core/error-text.js';

export type Listener = {
  server: net.Server;
  serveConnectionsWith: (serve: (socket: net.Socket) => void) => void;
  watchCertificates: (() => NodeJS.Timeout) | undefined;
};

type CertificateReload = {
  server: tls.Server;
  files: MutualTlsFiles;
  servedFingerprint: string;
  intervalMs: number;
  log: DaemonLog;
};

const UNIX_SOCKET_MODE = 0o600;

export function endpointOf(address: string | AddressInfo | null): DaemonEndpoint {
  if (address === null) {
    throw new Error('daemon server is not listening');
  }
  return typeof address === 'string' ? { socketPath: address } : { host: address.address, port: address.port };
}

function reloadTlsOnChange(reload: CertificateReload): NodeJS.Timeout {
  let { servedFingerprint } = reload;
  return setInterval(() => {
    try {
      const material = readTlsMaterial(reload.files);
      const fingerprint = tlsFingerprint(material);
      if (fingerprint === servedFingerprint) {
        return;
      }
      reload.server.setSecureContext(mutualTlsServerOptions(material));
      servedFingerprint = fingerprint;
      reload.log({ tlsReload: 'applied' });
    } catch (error) {
      reload.log({ tlsReload: 'failed', message: errorText(error) });
    }
  }, reload.intervalMs);
}

export function createListener(listen: DaemonListen, log: DaemonLog): Listener {
  if (listen.kind === 'unix') {
    const unixServer = net.createServer();
    return {
      server: unixServer,
      serveConnectionsWith: (serve) => {
        unixServer.on('connection', serve);
      },
      watchCertificates: undefined,
    };
  }
  if (!(listen.reloadMs > 0)) {
    throw badInput(`listen.reloadMs must be a positive number of milliseconds, got ${listen.reloadMs}.`);
  }
  const material = readTlsMaterial(listen.tls);
  const tlsServer = tls.createServer(mutualTlsServerOptions(material));
  tlsServer.on('tlsClientError', (error) => {
    log({ tlsClientError: error.message.trim() });
  });
  return {
    server: tlsServer,
    serveConnectionsWith: (serve) => {
      tlsServer.on('secureConnection', serve);
    },
    watchCertificates: () => reloadTlsOnChange({ server: tlsServer, files: listen.tls, servedFingerprint: tlsFingerprint(material), intervalMs: listen.reloadMs, log }),
  };
}

export async function bindServer(server: net.Server, listen: DaemonListen): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    const onListening = (): void => {
      server.off('error', reject);
      resolve();
    };
    if (listen.kind === 'unix') {
      server.listen(listen.socketPath, onListening);
    } else {
      server.listen(listen.port, listen.host, onListening);
    }
  });
  if (listen.kind === 'unix') {
    fs.chmodSync(listen.socketPath, UNIX_SOCKET_MODE);
  }
}

export function closeOnce(server: net.Server): () => Promise<void> {
  let closing: Promise<void> | null = null;
  return async () => {
    closing ??= new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    return closing;
  };
}
