import { readJsonFile, writeJsonFile } from '../core/json.js';

import { RuntimeConfigSchema } from './schemas.js';
import { textUnlessFalsy } from '../core/text-presence.js';

export type EnvironmentPolicy = {
  deterministicRequired: boolean;
  allowDiscoveryByDefault: boolean;
  preferredAccessMethods: string[];
  targetPreference: string[];
};

export type RuntimeConfig = {
  kbDir?: string;
  defaults?: {
    query?: {
      timeoutMs?: number;
      timeZone?: string;
    };
  };
  environmentPolicies?: Record<string, Partial<EnvironmentPolicy>>;
  serviceAliases?: Record<string, string>;
};

const DEFAULT_ENVIRONMENT_POLICY: EnvironmentPolicy = {
  deterministicRequired: false,
  allowDiscoveryByDefault: false,
  preferredAccessMethods: [],
  targetPreference: [],
};

function normalizeKey(value?: string): string {
  return textUnlessFalsy(value)
    .trim()
    .toLowerCase()
    .replaceAll(/\s+/gu, '-');
}

export class RuntimeConfigStore {
  private readonly file: string;

  public constructor(file: string) {
    this.file = file;
  }

  public get(): RuntimeConfig {
    const parsed = RuntimeConfigSchema.safeParse(readJsonFile<unknown>(this.file, {}));
    return parsed.success ? parsed.data : {};
  }

  public saveKbDir(kbDir: string): void {
    writeJsonFile(this.file, { ...readJsonFile<Record<string, unknown>>(this.file, {}), kbDir });
  }

  public environmentPolicy(env?: string): EnvironmentPolicy {
    const config = this.get();
    const key = normalizeKey(env);
    const current = key === '' ? undefined : (config.environmentPolicies ?? {})[key];
    return {
      ...DEFAULT_ENVIRONMENT_POLICY,
      ...current,
    };
  }

  public serviceAliases(): Record<string, string> {
    return this.get().serviceAliases ?? {};
  }

  public queryTimeoutMs(): number | undefined {
    const value = this.get().defaults?.query?.timeoutMs;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
  }

  public queryTimeZone(): string | undefined {
    const value = textUnlessFalsy(this.get().defaults?.query?.timeZone).trim();
    return value === '' ? undefined : value;
  }
}
