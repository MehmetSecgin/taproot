import type { ZodError } from 'zod';
import { DatasourceProfileSchema } from '../store/schemas.js';
import type { DatasourceProfile } from '../types/core.js';
import { nowIso } from './time.js';

export function extractImportArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.datasources)) return obj.datasources;
    const data = obj.data as Record<string, unknown> | unknown[] | undefined;
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).datasources)) {
      return (data as Record<string, unknown>).datasources as unknown[];
    }
  }
  throw new Error('Import source must be a JSON array of profiles, or an object with a `data`/`datasources` array.');
}

export function normalizeImportedProfile(raw: unknown, defaults: { credentialRef?: string }): Record<string, unknown> {
  const base: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  base.tags = Array.isArray(base.tags) ? base.tags : [];
  base.connectors = Array.isArray(base.connectors) ? base.connectors : [];
  base.connection = base.connection && typeof base.connection === 'object' ? base.connection : {};
  base.policy = base.policy && typeof base.policy === 'object'
    ? base.policy
    : { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] };
  base.confidence = typeof base.confidence === 'number' ? base.confidence : 0.8;
  base.updatedAt = typeof base.updatedAt === 'string' && base.updatedAt ? base.updatedAt : nowIso();
  if (!base.credentialRef && defaults.credentialRef) base.credentialRef = defaults.credentialRef;
  return base;
}

function firstZodError(error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid profile';
  const path = issue.path.join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

export function validateImportedProfile(raw: unknown, defaults: { credentialRef?: string }): { ok: true; profile: DatasourceProfile } | { ok: false; error: string } {
  const normalized = normalizeImportedProfile(raw, defaults);
  const parsed = DatasourceProfileSchema.safeParse(normalized);
  if (!parsed.success) return { ok: false, error: firstZodError(parsed.error) };
  return { ok: true, profile: parsed.data as DatasourceProfile };
}
