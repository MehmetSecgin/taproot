import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MutualTlsFiles } from '../../src/daemon/transport.js';

export interface TestPki {
  daemon: MutualTlsFiles;
  client: MutualTlsFiles;
}

const MAKE_CERTS = path.resolve(__dirname, '../../scripts/make-mtls-certs.sh');

export function createTestPki(daemonSubjectAltName = 'IP:127.0.0.1'): TestPki {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-pki-'));
  execFileSync(MAKE_CERTS, [dir, daemonSubjectAltName]);
  const file = (name: string) => path.join(dir, name);
  return {
    daemon: { caFile: file('ca.crt'), certFile: file('daemon.crt'), keyFile: file('daemon.key') },
    client: { caFile: file('ca.crt'), certFile: file('client.crt'), keyFile: file('client.key') },
  };
}
