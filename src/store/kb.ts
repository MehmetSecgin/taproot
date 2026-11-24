import fs from 'node:fs';
import path from 'node:path';
import { kbMissing } from '../core/taproot-error.js';
import { readJsonFile, writeJsonFile } from '../core/json.js';
import { isList, isRecord } from '../core/json-shapes.js';
import { normalizeRelations } from '../core/relations.js';
import type { KbRelation } from '../core/relations.js';
import { isNonEmpty, textUnlessFalsy } from '../core/text-presence.js';

type KbRow = Record<string, unknown>;

type KbTableRow = { service?: unknown; env?: unknown; database?: unknown; tables?: string[] };

const ACTIVE_CONNECTION_STATUS = 'active';

function isStatusMissing(status: unknown): boolean {
  return status === undefined || status === null || status === '' || status === 0 || status === false;
}

function isActiveConnectionIn(connection: KbRow, env: string, namespace: string | undefined): boolean {
  const status = isStatusMissing(connection.status) ? ACTIVE_CONNECTION_STATUS : String(connection.status);
  if (String(connection.env) !== env || status !== ACTIVE_CONNECTION_STATUS) {
    return false;
  }
  return !isNonEmpty(namespace) || textUnlessFalsy(connection.namespace) === namespace;
}

function newestVerifiedFirst(first: KbRow, second: KbRow): number {
  return textUnlessFalsy(second.verified_at_utc).localeCompare(textUnlessFalsy(first.verified_at_utc));
}

export class KbStore {
  private readonly kbDir: string;

  public constructor(kbDir: string) {
    this.kbDir = kbDir;
  }

  public missingReason(): string | undefined {
    if (this.services().length > 0) {
      return undefined;
    }
    const state = fs.existsSync(this.kbDir) ? 'has no services in services.json' : 'does not exist';
    return `KB directory ${this.kbDir} ${state}. Set it with 'taproot init --kb-dir <dir>' (saved in TapRoot config) or TAPROOT_KB_DIR.`;
  }

  public requirePresent(): void {
    const reason = this.missingReason();
    if (reason !== undefined) {
      throw kbMissing(reason);
    }
  }

  public services(): KbRow[] {
    return readJsonFile<KbRow[]>(this.file('services.json'), []);
  }

  public typedRelations(): KbRelation[] {
    const file = this.file('relations.json');
    const stored: unknown = readJsonFile<unknown>(file, []);
    if (stored === null) {
      return [];
    }
    if (!isList(stored)) {
      throw new TypeError(`${file} must hold a JSON array of relation objects.`);
    }
    return normalizeRelations(stored);
  }

  public promoteRelations(candidates: KbRelation[]): { added: number; total: number } {
    const existing = this.typedRelations();
    const relationsById = new Map(existing.map((relation) => [relation.id, relation]));
    let added = 0;
    for (const candidate of candidates) {
      if (!relationsById.has(candidate.id)) {
        relationsById.set(candidate.id, candidate);
        added += 1;
      }
    }
    const merged = [...relationsById.values()];
    writeJsonFile(this.file('relations.json'), merged);
    return { added, total: merged.length };
  }

  public tables(): KbTableRow[] {
    return readJsonFile<KbTableRow[]>(this.file('table-catalog.json'), []);
  }

  public listServices(): string[] {
    const names = this.services().map((row) => textUnlessFalsy(row.service).trim());
    return [...new Set(names.filter((name) => name !== ''))].toSorted((first, second) => first.localeCompare(second));
  }

  public resolveConnection(service: string, env: string, namespace?: string): KbRow | null {
    const kbService = this.services().find((row) => textUnlessFalsy(row.service).trim().toLowerCase() === service.toLowerCase());
    if (kbService === undefined) {
      return null;
    }
    const connections: unknown[] = Array.isArray(kbService.connections) ? kbService.connections : [];
    const active = connections.filter((candidate) => isRecord(candidate)).filter((connection) => isActiveConnectionIn(connection, env, namespace));
    return active.toSorted(newestVerifiedFirst).at(0) ?? null;
  }

  private file(name: string): string {
    return path.join(this.kbDir, name);
  }
}
