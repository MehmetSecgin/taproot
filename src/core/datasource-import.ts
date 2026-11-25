import { parseDatasourceProfile } from '../store/schemas.js';
import { readOnlyPolicy } from './read-only-policy.js';
import { nowIso } from './time.js';
import { isList, isRecord } from './json-shapes.js';

type ImportDefaults = { credentialRef?: string };

function findImportedArray(parsed: unknown): unknown[] | undefined {
  if (isList(parsed)) {
    return parsed;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  if (isList(parsed.datasources)) {
    return parsed.datasources;
  }
  const { data } = parsed;
  if (isList(data)) {
    return data;
  }
  return isRecord(data) && isList(data.datasources) ? data.datasources : undefined;
}

export function extractImportArray(parsed: unknown): unknown[] {
  const imported = findImportedArray(parsed);
  if (imported === undefined) {
    throw new Error('Import source must be a JSON array of profiles, or an object with a `data`/`datasources` array.');
  }
  return imported;
}

function normalizeImportedProfile(raw: unknown, defaults: ImportDefaults): Record<string, unknown> {
  const base: Record<string, unknown> = isRecord(raw) ? { ...raw } : {};
  base.tags = isList(base.tags) ? base.tags : [];
  base.connectors = isList(base.connectors) ? base.connectors : [];
  base.connection = isRecord(base.connection) ? base.connection : {};
  base.policy = isRecord(base.policy) ? base.policy : readOnlyPolicy();
  base.updatedAt = typeof base.updatedAt === 'string' && base.updatedAt !== '' ? base.updatedAt : nowIso();
  const hasCredentialRef = Boolean(base.credentialRef);
  if (!hasCredentialRef && defaults.credentialRef !== undefined && defaults.credentialRef !== '') {
    base.credentialRef = defaults.credentialRef;
  }
  return base;
}

export function validateImportedProfile(raw: unknown, defaults: ImportDefaults): ReturnType<typeof parseDatasourceProfile> {
  return parseDatasourceProfile(normalizeImportedProfile(raw, defaults));
}
