import { createHash } from 'node:crypto';

const DERIVED_PORT_BASE = 20_000;
const DERIVED_PORT_RANGE = 10_000;
const DEFAULT_NAMESPACE = 'default';

export function kubectlPortforwardLocalPort(env: string, namespace: string | undefined, service: string): number {
  const namespaceOrDefault = namespace === undefined || namespace === '' ? DEFAULT_NAMESPACE : namespace;
  const digest = createHash('sha256').update(`${env}/${namespaceOrDefault}/${service}`).digest();
  return DERIVED_PORT_BASE + (digest.readUInt32BE(0) % DERIVED_PORT_RANGE);
}
