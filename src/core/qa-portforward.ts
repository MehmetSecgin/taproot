import { createHash } from 'node:crypto';
import { badInput } from './error-classification.js';

const DERIVED_PORT_BASE = 20000;
const DERIVED_PORT_RANGE = 10000;
const MAX_PORT = 65535;

function localPortOverride(): number | undefined {
  const raw = (process.env.TAPROOT_QA_LOCAL_PORT || '').trim();
  if (!raw) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw badInput(`TAPROOT_QA_LOCAL_PORT must be a port from 1 to ${MAX_PORT}, got '${raw}'.`);
  }
  return port;
}

export function qaPortforwardLocalPort(env: string, namespace: string | undefined, service: string): number {
  const override = localPortOverride();
  if (override) return override;
  const digest = createHash('sha256').update(`${env}/${namespace || 'default'}/${service}`).digest();
  return DERIVED_PORT_BASE + (digest.readUInt32BE(0) % DERIVED_PORT_RANGE);
}
