import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile, writeJsonFile } from '../core/json.js';
import { nowIso } from '../core/time.js';
import type { TableContext } from '../types/schema-context.js';

export type SchemaCatalog = {
  datasource: string;
  fetchedAt: string;
  tables: Record<string, TableContext>;
};

function readTreatingCorruptAsMissing(file: string): SchemaCatalog | undefined {
  try {
    return readJsonFile<SchemaCatalog | null>(file, null) ?? undefined;
  } catch {
    return undefined;
  }
}

export class SchemaCatalogStore {
  private readonly dir: string;

  public constructor(dir: string) {
    this.dir = dir;
  }

  public get(datasource: string): SchemaCatalog | undefined {
    return readTreatingCorruptAsMissing(this.file(datasource));
  }

  public save(datasource: string, tables: Record<string, TableContext>): SchemaCatalog {
    const catalog = { datasource, fetchedAt: nowIso(), tables };
    fs.mkdirSync(this.dir, { recursive: true });
    writeJsonFile(this.file(datasource), catalog);
    return catalog;
  }

  public list(): { datasource: string; fetchedAt: string; tables: number }[] {
    if (!fs.existsSync(this.dir)) {
      return [];
    }
    return fs.readdirSync(this.dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => readTreatingCorruptAsMissing(path.join(this.dir, name)))
      .filter((catalog): catalog is SchemaCatalog => catalog !== undefined)
      .map((catalog) => ({ datasource: catalog.datasource, fetchedAt: catalog.fetchedAt, tables: Object.keys(catalog.tables ?? {}).length }));
  }

  public clear(): number {
    const count = this.list().length;
    fs.rmSync(this.dir, { recursive: true, force: true });
    return count;
  }

  private file(datasource: string): string {
    return path.join(this.dir, `${datasource.replaceAll(/[^A-Za-z0-9._-]/gu, '_')}.json`);
  }
}
