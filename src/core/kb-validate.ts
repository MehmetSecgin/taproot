import { AccessMethod } from '../types/core.js';

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const ACCESS_METHODS: readonly string[] = Object.values(AccessMethod);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isPort(value: unknown): boolean {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 && value <= 65535;
  return typeof value === 'string' && /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 65535;
}

function isTimestamp(value: string): boolean {
  return ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

function connectionFindings(service: string, connections: unknown, servicePath: string): string[] {
  if (connections === undefined) return [];
  if (!Array.isArray(connections)) return [`${servicePath}.connections: must be an array`];
  const findings: string[] = [];
  connections.forEach((connection: unknown, index: number) => {
    const at = `${servicePath}.connections[${index}]`;
    if (!connection || typeof connection !== 'object' || Array.isArray(connection)) {
      findings.push(`${at}: must be an object`);
      return;
    }
    const row = connection as Record<string, unknown>;
    const label = `${service}: ${at}`;
    if (!isNonEmptyString(row.env)) findings.push(`${label}.env: required non-empty string`);
    for (const key of ['namespace', 'status', 'engine', 'database', 'db_user', 'host', 'target']) {
      if (!isOptionalString(row[key])) findings.push(`${label}.${key}: must be a string`);
    }
    if (row.port !== undefined && !isPort(row.port)) findings.push(`${label}.port: must be an integer from 1 to 65535`);
    if (row.access_method !== undefined && !ACCESS_METHODS.includes(String(row.access_method))) {
      findings.push(`${label}.access_method: '${String(row.access_method)}' is not a known access method (${ACCESS_METHODS.join(', ')})`);
    }
    if (row.verified_at_utc !== undefined && (typeof row.verified_at_utc !== 'string' || !isTimestamp(row.verified_at_utc))) {
      findings.push(`${label}.verified_at_utc: must be an ISO 8601 timestamp with a timezone`);
    }
  });
  return findings;
}

export function validateServicesDocument(document: unknown): string[] {
  if (!Array.isArray(document)) return ['services: the document must be an array of service rows'];
  const findings: string[] = [];
  document.forEach((row: unknown, index: number) => {
    const at = `services[${index}]`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      findings.push(`${at}: must be an object`);
      return;
    }
    const service = (row as Record<string, unknown>).service;
    if (!isNonEmptyString(service)) {
      findings.push(`${at}.service: required non-empty string`);
      return;
    }
    findings.push(...connectionFindings(service, (row as Record<string, unknown>).connections, `${at} (${service})`));
  });
  return findings;
}
