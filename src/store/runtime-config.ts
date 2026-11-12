import { readJsonFile, writeJsonFile } from '../core/json.js';
import type { EnvironmentPolicy, RuntimeConfig } from '../types/core.js';
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
  private checked?: { raw: unknown; config: RuntimeConfig };

  constructor(private readonly file: string) {}

  get(): RuntimeConfig {
    const raw = readJsonFile<unknown>(this.file, {});
    if (this.checked && this.checked.raw === raw) return this.checked.config;
    const parsed = RuntimeConfigSchema.safeParse(raw);
    const config = parsed.success ? parsed.data : {};
    this.checked = { raw, config };
    return config;
  }

  saveKbDir(kbDir: string): void {
    writeJsonFile(this.file, { ...readJsonFile<Record<string, unknown>>(this.file, {}), kbDir });
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

  queryTimeoutMs(): number | undefined {
    const value = this.get().defaults?.query?.timeoutMs;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
  }

  queryTimeZone(): string | undefined {
    const value = str(this.get().defaults?.query?.timeZone).trim();
    return value || undefined;
  }
}
