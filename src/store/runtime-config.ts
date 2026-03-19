import { readJsonFile } from '../core/json.js';
import type { EnvironmentPolicy, RuntimeConfig } from '../types/core.js';
import { RuntimeConfigSchema } from './schemas.js';

const DEFAULT_ENVIRONMENT_POLICY: EnvironmentPolicy = {
  deterministicRequired: false,
  allowDiscoveryByDefault: false,
  preferredAccessMethods: [],
  targetPreference: [],
};

function normalizeKey(value?: string): string {
  return String(value || '')
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

  serviceAliases(): Record<string, string> {
    return this.get().serviceAliases || {};
  }
}
