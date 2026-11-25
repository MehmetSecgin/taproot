import { z } from 'zod';
import type { ZodError } from 'zod';
import type { Capability, DatasourceProfile } from '../types/datasource.js';

const StoredCapabilitySchema = z.string().pipe(z.custom<Capability>(() => true));

const DatasourcePolicySchema = z.object({
  allowRead: z.boolean().default(true),
  allowMutate: z.boolean().default(false),
  allowedCapabilities: z.array(StoredCapabilitySchema).default(['executeRead']),
  requireDatabase: z.boolean().optional(),
  strictKeyspace: z.boolean().optional(),
});

const DatasourceProfileSchema = z.object({
  name: z.string().min(1),
  kind: z.string().min(1),
  env: z.string().optional(),
  namespace: z.string().optional(),
  service: z.string().optional(),
  tags: z.array(z.string()).default([]),
  connection: z.object({
    host: z.string().optional(),
    port: z.number().int().positive().optional(),
    database: z.string().optional(),
    target: z.string().optional(),
    ssl: z.boolean().optional(),
  }),
  credentialRef: z.string().min(1),
  connectors: z.array(z.string()).default([]),
  policy: DatasourcePolicySchema,
  resolverHints: z.record(z.string(), z.string()).optional(),
  updatedAt: z.string(),
});

function firstZodError(error: ZodError): string {
  const [issue] = error.issues;
  if (issue === undefined) {
    return 'invalid profile';
  }
  const path = issue.path.join('.');
  return path === '' ? issue.message : `${path}: ${issue.message}`;
}

export function parseDatasourceProfile(raw: unknown): { ok: true; profile: DatasourceProfile } | { ok: false; error: string } {
  const parsed = DatasourceProfileSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: firstZodError(parsed.error) };
  }
  return { ok: true, profile: parsed.data };
}

const EnvironmentPolicySchema = z.object({
  deterministicRequired: z.boolean().default(false),
  allowDiscoveryByDefault: z.boolean().default(false),
  preferredAccessMethods: z.array(z.string()).default([]),
  targetPreference: z.array(z.string()).default([]),
});

const QueryDefaultsSchema = z.object({
  timeoutMs: z.number().int().positive().optional(),
  timeZone: z.string().optional(),
});

const PartialEnvironmentPolicySchema = EnvironmentPolicySchema.partial();

export const RuntimeConfigSchema = z.object({
  kbDir: z.string().optional(),
  defaults: z.object({ query: QueryDefaultsSchema.optional() }).optional(),
  environmentPolicies: z.record(z.string(), PartialEnvironmentPolicySchema).optional(),
  serviceAliases: z.record(z.string(), z.string()).optional(),
});
