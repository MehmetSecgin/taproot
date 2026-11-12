import { readJsonFile, writeJsonFile } from '../core/json.js';
import type { DatasourceProfile } from '../types/core.js';
import { parseDatasourceProfile } from './schemas.js';
import { str } from '../core/strings.js';

function rowName(row: unknown): string {
  return str((row as { name?: unknown } | null)?.name);
}

export class DatasourceStore {
  constructor(private readonly file: string) {}

  private rows(): unknown[] {
    const raw = readJsonFile<unknown>(this.file, []);
    if (!Array.isArray(raw)) throw new Error(`${this.file} must hold a JSON array of datasource profiles. Fix it; TapRoot does not overwrite it until then.`);
    return raw;
  }

  load(): { profiles: DatasourceProfile[]; warnings: string[] } {
    const profiles: DatasourceProfile[] = [];
    const warnings: string[] = [];
    this.rows().forEach((row, index) => {
      const parsed = parseDatasourceProfile(row);
      if (parsed.ok) profiles.push(parsed.profile);
      else warnings.push(`skipped invalid datasource ${rowName(row) || `#${index}`}: ${parsed.error}`);
    });
    return { profiles, warnings };
  }

  list(): DatasourceProfile[] {
    return this.load().profiles;
  }

  get(name: string): DatasourceProfile | undefined {
    return this.list().find((d) => d.name === name);
  }

  save(profile: DatasourceProfile): DatasourceProfile {
    const rows = this.rows().filter((row) => rowName(row) !== profile.name);
    rows.push(profile);
    writeJsonFile(this.file, rows);
    return profile;
  }

  remove(name: string): boolean {
    const rows = this.rows();
    const next = rows.filter((row) => rowName(row) !== name);
    if (next.length === rows.length) return false;
    writeJsonFile(this.file, next);
    return true;
  }

  resolveByEnvService(env: string, service: string, namespace?: string, preferKinds: readonly string[] = []): DatasourceProfile | undefined {
    const all = this.list();
    const tryMatch = (envValue: string, nsValue?: string): DatasourceProfile | undefined => {
      const filtered = all.filter((d) => {
        if (d.env !== envValue || d.service !== service) return false;
        if (nsValue == null || nsValue === '') return true;
        return str(d.namespace) === nsValue;
      });
      if (!filtered.length) return undefined;
      const ofKind = filtered.filter((d) => preferKinds.includes(d.kind));
      return (ofKind.length ? ofKind : filtered).sort((a, b) => (b.confidence - a.confidence) || b.updatedAt.localeCompare(a.updatedAt))[0];
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
