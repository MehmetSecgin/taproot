import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile, writeJsonFile } from '../core/json.js';
import type { TableContext } from '../types/core.js';

export interface SchemaCatalog {
  datasource: string;
  fetchedAt: string;
  tables: Record<string, TableContext>;
}

export class SchemaCatalogStore {
  constructor(private readonly dir: string) {}

  private file(datasource: string): string {
    return path.join(this.dir, `${datasource.replace(/[^a-z0-9._-]/gi, '_')}.json`);
  }

  private readTreatingCorruptAsMissing(file: string): SchemaCatalog | undefined {
    try {
      return readJsonFile<SchemaCatalog | undefined>(file, undefined);
    } catch {
      return undefined;
    }
  }

  get(datasource: string): SchemaCatalog | undefined {
    return this.readTreatingCorruptAsMissing(this.file(datasource));
  }

  save(datasource: string, tables: Record<string, TableContext>): SchemaCatalog {
    const catalog = { datasource, fetchedAt: new Date().toISOString(), tables };
    fs.mkdirSync(this.dir, { recursive: true });
    writeJsonFile(this.file(datasource), catalog);
    return catalog;
  }

  list(): Array<{ datasource: string; fetchedAt: string; tables: number }> {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => this.readTreatingCorruptAsMissing(path.join(this.dir, name)))
      .filter((catalog): catalog is SchemaCatalog => Boolean(catalog))
      .map((catalog) => ({ datasource: catalog.datasource, fetchedAt: catalog.fetchedAt, tables: Object.keys(catalog.tables || {}).length }));
  }

  clear(): number {
    const count = this.list().length;
    fs.rmSync(this.dir, { recursive: true, force: true });
    return count;
  }
}
