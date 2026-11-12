import { createHash } from 'node:crypto';

const DERIVED_PORT_BASE = 20000;
const DERIVED_PORT_RANGE = 10000;

export function qaPortforwardLocalPort(env: string, namespace: string | undefined, service: string): number {
  const override = Number(process.env.TAPROOT_QA_LOCAL_PORT);
  if (override) return override;
  const digest = createHash('sha256').update(`${env}/${namespace || 'default'}/${service}`).digest();
  return DERIVED_PORT_BASE + (digest.readUInt32BE(0) % DERIVED_PORT_RANGE);
}
