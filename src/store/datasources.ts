import { readJsonFile, writeJsonFile } from '../core/json.js';
import type { DatasourceProfile } from '../types/core.js';
import { DatasourceProfileListSchema } from './schemas.js';

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

  resolveByEnvService(env: string, service: string): DatasourceProfile | undefined {
    const filtered = this.list().filter((d) => d.env === env && d.service === service);
    if (!filtered.length) return undefined;
    return filtered.sort((a, b) => (b.confidence - a.confidence) || b.updatedAt.localeCompare(a.updatedAt))[0];
  }
}
