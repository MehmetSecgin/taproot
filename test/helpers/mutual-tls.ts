import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MutualTlsFiles } from '../../src/daemon/transport.js';

export type TestPki = {
  daemon: MutualTlsFiles;
  client: MutualTlsFiles;
};

const MAKE_CERTS = fileURLToPath(new URL('../../scripts/make-mtls-certs.sh', import.meta.url));

export function createTestPki(daemonSubjectAltName = 'IP:127.0.0.1'): TestPki {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-pki-'));
  execFileSync(MAKE_CERTS, [dir, daemonSubjectAltName]);
  const file = (name: string): string => path.join(dir, name);
  return {
    daemon: { caFile: file('ca.crt'), certFile: file('daemon.crt'), keyFile: file('daemon.key') },
    client: { caFile: file('ca.crt'), certFile: file('client.crt'), keyFile: file('client.key') },
  };
}
