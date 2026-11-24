import { readJsonFile, writeJsonFile } from '../core/json.js';
import type { DatasourceProfile } from '../types/datasource.js';
import { parseDatasourceProfile } from './schemas.js';
import { isNonEmpty, textUnlessFalsy } from '../core/text-presence.js';
import { ambiguousDatasource } from '../core/taproot-error.js';
import { isRecord } from '../core/json-shapes.js';

type ServiceQuery = {
  env: string;
  namespace: string | undefined;
  service: string;
  preferKinds: readonly string[];
};

type AmbiguousMatch = {
  candidates: DatasourceProfile[];
  env: string;
  service: string;
  namespace: string | undefined;
};

function ambiguousMatchError(match: AmbiguousMatch): Error {
  const names = match.candidates.map((candidate) => candidate.name);
  const target = `env=${match.env}${isNonEmpty(match.namespace) ? ` namespace=${match.namespace}` : ''} service=${match.service}`;
  const pickByName = 'use --datasource <name> on query and doctor';
  const fix = isNonEmpty(match.namespace) ? `Pick one: ${pickByName}.` : `Narrow with --namespace, or ${pickByName}.`;
  return ambiguousDatasource(`${names.length} datasources match ${target}: ${names.join(', ')}. ${fix}`);
}

function rowName(row: unknown): string {
  return isRecord(row) ? textUnlessFalsy(row.name) : '';
}

function findUniqueProfile(profiles: DatasourceProfile[], query: ServiceQuery): DatasourceProfile | undefined {
  const { env, namespace, service } = query;
  const matching = profiles.filter((profile) => {
    if (profile.env !== env || profile.service !== service) {
      return false;
    }
    return !isNonEmpty(namespace) || textUnlessFalsy(profile.namespace) === namespace;
  });
  const ofPreferredKind = matching.filter((profile) => query.preferKinds.includes(profile.kind));
  const candidates = ofPreferredKind.length > 0 ? ofPreferredKind : matching;
  if (candidates.length > 1) {
    throw ambiguousMatchError({ candidates, env, service, namespace });
  }
  return candidates[0];
}

function findWithEnvSplitIntoNamespace(profiles: DatasourceProfile[], query: ServiceQuery): DatasourceProfile | undefined {
  const separatorIndex = query.env.indexOf('-');
  if (separatorIndex === -1) {
    return undefined;
  }
  return findUniqueProfile(profiles, { ...query, env: query.env.slice(0, separatorIndex), namespace: query.env.slice(separatorIndex + 1) });
}

export class DatasourceStore {
  private readonly file: string;

  public constructor(file: string) {
    this.file = file;
  }

  public load(): { profiles: DatasourceProfile[]; warnings: string[] } {
    const profiles: DatasourceProfile[] = [];
    const warnings: string[] = [];
    for (const [index, row] of this.rawRows().entries()) {
      const parsed = parseDatasourceProfile(row);
      if (parsed.ok) {
        profiles.push(parsed.profile);
      } else {
        const label = rowName(row) === '' ? `#${index}` : rowName(row);
        warnings.push(`skipped invalid datasource ${label}: ${parsed.error}`);
      }
    }
    return { profiles, warnings };
  }

  public list(): DatasourceProfile[] {
    return this.load().profiles;
  }

  public get(name: string): DatasourceProfile | undefined {
    return this.list().find((profile) => profile.name === name);
  }

  public save(profile: DatasourceProfile): DatasourceProfile {
    const rows = this.rawRows().filter((row) => rowName(row) !== profile.name);
    rows.push(profile);
    writeJsonFile(this.file, rows);
    return profile;
  }

  public remove(name: string): boolean {
    const rows = this.rawRows();
    const remaining = rows.filter((row) => rowName(row) !== name);
    if (remaining.length === rows.length) {
      return false;
    }
    writeJsonFile(this.file, remaining);
    return true;
  }

  public resolveByEnvService(env: string, service: string, namespace?: string, preferKinds: readonly string[] = []): DatasourceProfile | undefined {
    const profiles = this.list();
    const query: ServiceQuery = { env, namespace, service, preferKinds };
    const direct = findUniqueProfile(profiles, query);
    if (direct !== undefined) {
      return direct;
    }
    return isNonEmpty(namespace) ? undefined : findWithEnvSplitIntoNamespace(profiles, query);
  }

  private rawRows(): unknown[] {
    const raw = readJsonFile<unknown>(this.file, []);
    if (!Array.isArray(raw)) {
      throw new TypeError(`${this.file} must hold a JSON array of datasource profiles. Fix it; TapRoot does not overwrite it until then.`);
    }
    return raw;
  }
}
