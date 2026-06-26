import { z } from 'zod';

export const DatasourcePolicySchema = z.object({
  allowRead: z.boolean().default(true),
  allowMutate: z.boolean().default(false),
  allowedCapabilities: z.array(z.string()).default(['executeRead']),
});

export const DatasourceProfileSchema = z.object({
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
  confidence: z.number().min(0).max(1),
});

export const QueryTemplateSchema = z.object({
  id: z.string().min(1),
  datasourceKind: z.string().optional(),
  datasourceName: z.string().optional(),
  intent: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  nativeQueryTemplate: z.string().min(1),
  params: z.array(z.string()).default([]),
  resultShape: z.enum(['table', 'json', 'summary']).default('table'),
  tags: z.array(z.string()).default([]),
  status: z.enum(['active', 'inactive']).default('active'),
  verifiedAt: z.string().optional(),
});

export const DatasourceProfileListSchema = z.array(DatasourceProfileSchema);
export const QueryTemplateListSchema = z.array(QueryTemplateSchema);

export const EnvironmentPolicySchema = z.object({
  deterministicRequired: z.boolean().default(false),
  allowDiscoveryByDefault: z.boolean().default(false),
  preferredAccessMethods: z.array(z.string()).default([]),
  targetPreference: z.array(z.string()).default([]),
  ledgerRedactionTier: z.enum(['raw', 'redact', 'strict']).optional(),
});

export const RuntimeConfigSchema = z.object({
  defaults: z.object({
    profile: z.string().optional(),
    json: z.boolean().optional(),
    noColor: z.boolean().optional(),
    noAnimations: z.boolean().optional(),
    query: z.object({
      timeoutMs: z.number().int().positive().optional(),
      timeZone: z.string().optional(),
    }).optional(),
    learning: z.object({
      enabled: z.boolean().optional(),
      sampleRowsMax: z.number().int().positive().optional(),
      sampleCellMax: z.number().int().positive().optional(),
      ttlHours: z.number().int().positive().optional(),
    }).optional(),
    ledger: z.object({
      redactionTier: z.enum(['raw', 'redact', 'strict']).optional(),
    }).optional(),
    cardRoots: z.array(z.string()).optional(),
  }).optional(),
  cardRoots: z.array(z.string()).optional(),
  environmentPolicies: z.record(z.string(), EnvironmentPolicySchema.partial()).optional(),
  serviceAliases: z.record(z.string(), z.string()).optional(),
});

export type DatasourceProfileInput = z.infer<typeof DatasourceProfileSchema>;
export type QueryTemplateInput = z.infer<typeof QueryTemplateSchema>;
export type RuntimeConfigInput = z.infer<typeof RuntimeConfigSchema>;
