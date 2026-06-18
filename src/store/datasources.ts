import { readJsonFile, writeJsonFile } from '../core/json.js';
import type { DatasourceProfile } from '../types/core.js';
import { DatasourceProfileListSchema } from './schemas.js';
import { str } from '../core/strings.js';

export class DatasourceStore {
  constructor(private readonly file: string) {}

  list(): DatasourceProfile[] {
    const raw = readJsonFile<unknown>(this.file, []);
    const parsed = DatasourceProfileListSchema.safeParse(raw);
    return parsed.success ? (parsed.data as DatasourceProfile[]) : [];
  }

  get(name: string): DatasourceProfile | undefined {
    return this.list().find((d) => d.name === name);
  }

  save(profile: DatasourceProfile): DatasourceProfile {
    const all = this.list().filter((d) => d.name !== profile.name);
    all.push(profile);
    writeJsonFile(this.file, all);
    return profile;
  }

  remove(name: string): boolean {
    const all = this.list();
    const next = all.filter((d) => d.name !== name);
    if (next.length === all.length) return false;
    writeJsonFile(this.file, next);
    return true;
  }

  resolveByEnvService(env: string, service: string, namespace?: string): DatasourceProfile | undefined {
    const all = this.list();
    const tryMatch = (envValue: string, nsValue?: string): DatasourceProfile | undefined => {
      const filtered = all.filter((d) => {
        if (d.env !== envValue || d.service !== service) return false;
        if (nsValue == null || nsValue === '') return true;
        return str(d.namespace) === nsValue;
      });
      if (!filtered.length) return undefined;
      return filtered.sort((a, b) => (b.confidence - a.confidence) || b.updatedAt.localeCompare(a.updatedAt))[0];
    };

    const direct = tryMatch(env, namespace);
    if (direct) return direct;

    // Fallback: callers commonly pass `qa-develop` or `qa-test` as a single token.
    // Split on the first `-` and retry as env+namespace before declaring no match.
    if (!namespace && env.includes('-')) {
      const dashIdx = env.indexOf('-');
      const envPart = env.slice(0, dashIdx);
      const nsPart = env.slice(dashIdx + 1);
      const splitMatch = tryMatch(envPart, nsPart);
      if (splitMatch) return splitMatch;
    }
    return undefined;
  }

  candidatesByService(service: string): DatasourceProfile[] {
    return this.list().filter((d) => d.service === service);
  }
}
