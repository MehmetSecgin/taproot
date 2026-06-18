import { readJsonFile } from '../core/json.js';
import type { EnvironmentPolicy, LedgerRedactionTier, RuntimeConfig } from '../types/core.js';
import { RuntimeConfigSchema } from './schemas.js';
import { str } from '../core/strings.js';

const DEFAULT_ENVIRONMENT_POLICY: EnvironmentPolicy = {
  deterministicRequired: false,
  allowDiscoveryByDefault: false,
  preferredAccessMethods: [],
  targetPreference: [],
};

function normalizeKey(value?: string): string {
  return str(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

export class RuntimeConfigStore {
  constructor(private readonly file: string) {}

  get(): RuntimeConfig {
    const raw = readJsonFile<unknown>(this.file, {});
    const parsed = RuntimeConfigSchema.safeParse(raw);
    return parsed.success ? parsed.data : {};
  }

  environmentPolicy(env?: string): EnvironmentPolicy {
    const config = this.get();
    const key = normalizeKey(env);
    const current = key ? (config.environmentPolicies || {})[key] : undefined;
    return {
      ...DEFAULT_ENVIRONMENT_POLICY,
      ...(current || {}),
    };
  }

  ledgerRedactionTier(env?: string): LedgerRedactionTier {
    const config = this.get();
    const key = normalizeKey(env);
    const policyTier = key ? (config.environmentPolicies || {})[key]?.ledgerRedactionTier : undefined;
    const defaultTier = config.defaults?.ledger?.redactionTier;
    if (policyTier) return policyTier;
    if (defaultTier) return defaultTier;
    if (/^(prod|production)$/.test(key)) return 'strict';
    if (/^(qa|stage|staging|uat|preprod|pre-prod)$/.test(key)) return 'redact';
    if (/^(dev|develop|development|local|sandbox)$/.test(key)) return 'raw';
    return 'redact';
  }

  cardRoots(): string[] {
    const config = this.get();
    return [...(config.defaults?.cardRoots || []), ...(config.cardRoots || [])]
      .map((item) => str(item).trim())
      .filter(Boolean);
  }

  serviceAliases(): Record<string, string> {
    return this.get().serviceAliases || {};
  }
}
