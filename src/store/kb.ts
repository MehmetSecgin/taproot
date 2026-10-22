import fs from 'node:fs';
import path from 'node:path';
import { kbMissing } from '../core/error-classification.js';
import { readJsonFile, writeJsonFile } from '../core/json.js';
import { normalizeRelations } from '../core/relations.js';
import type { KbRelation } from '../types/core.js';
import { str } from '../core/strings.js';

export class KbStore {
  constructor(private readonly kbDir: string) {}

  private file(name: string): string {
    return path.join(this.kbDir, name);
  }

  missingReason(): string | undefined {
    if (this.services().length) return undefined;
    const state = fs.existsSync(this.kbDir) ? 'has no services in services.json' : 'does not exist';
    return `KB directory ${this.kbDir} ${state}. Set it with 'taproot init --kb-dir <dir>' (saved in TapRoot config) or TAPROOT_KB_DIR.`;
  }

  requirePresent(): void {
    const reason = this.missingReason();
    if (reason) throw kbMissing(reason);
  }

  services(): any[] {
    return readJsonFile<any[]>(this.file('services.json'), []);
  }

  relations(): any[] {
    return readJsonFile<any[]>(this.file('relations.json'), []);
  }

  typedRelations(): KbRelation[] {
    return normalizeRelations(this.relations());
  }

  promoteRelations(candidates: KbRelation[]): { added: number; total: number } {
    const existing = this.typedRelations();
    const byId = new Map(existing.map((rel) => [rel.id, rel]));
    let added = 0;
    for (const candidate of candidates) {
      if (byId.has(candidate.id)) continue;
      byId.set(candidate.id, candidate);
      added += 1;
    }
    const merged = [...byId.values()];
    writeJsonFile(this.file('relations.json'), merged);
    return { added, total: merged.length };
  }

  tables(): any[] {
    return readJsonFile<any[]>(this.file('table-catalog.json'), []);
  }

  listServices(): string[] {
    return Array.from(
      new Set(
        this.services()
          .map((row) => str(row.service).trim())
          .filter(Boolean),
      ),
    ).sort((a, b) => a.localeCompare(b));
  }

  resolveConnection(service: string, env: string, namespace?: string): Record<string, unknown> | null {
    const svc = this.services().find((s) => str(s.service).trim().toLowerCase() === service.toLowerCase());
    if (!svc) return null;
    const conns = Array.isArray(svc.connections) ? svc.connections : [];
    const active = conns.filter((c: any) => {
      if (String(c.env) !== env || String(c.status || 'active') !== 'active') return false;
      if (namespace == null || namespace === '') return true;
      return str(c.namespace) === namespace;
    });
    if (!active.length) return null;
    return active.sort((a: any, b: any) => str(b.verified_at_utc).localeCompare(str(a.verified_at_utc)))[0];
  }

}
