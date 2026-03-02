import fs from 'node:fs';
import path from 'node:path';
import type { DatasourceProfile, QueryResult } from '../types/core.js';
import { nowIso } from '../core/time.js';
import { readJsonFile, writeJsonFile } from '../core/json.js';

interface LearningRecord {
  datasource: string;
  env?: string;
  service?: string;
  resolvedAt: string;
  confidence: number;
  queryIntent?: string;
  querySignature?: string;
  sampleRows?: Array<Record<string, unknown>>;
}

function signature(sql: string): string {
  return sql.trim().replace(/\s+/g, ' ').toLowerCase();
}

function capRows(rows: Array<Record<string, unknown>>, maxRows = 20, maxCell = 256): Array<Record<string, unknown>> {
  return rows.slice(0, maxRows).map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      const s = String(v ?? '');
      out[k] = s.length > maxCell ? `${s.slice(0, maxCell)}...` : v;
    }
    return out;
  });
}

export class LearningStore {
  private readonly file: string;

  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'records.json');
  }

  list(): LearningRecord[] {
    return readJsonFile<LearningRecord[]>(this.file, []);
  }

  saveSuccess(input: {
    datasource: DatasourceProfile;
    queryIntent?: string;
    sql: string;
    result: QueryResult;
  }): void {
    const rows = this.list();
    const rec: LearningRecord = {
      datasource: input.datasource.name,
      env: input.datasource.env,
      service: input.datasource.service,
      resolvedAt: nowIso(),
      confidence: Math.min(1, input.datasource.confidence + 0.02),
      queryIntent: input.queryIntent,
      querySignature: signature(input.sql),
      sampleRows: capRows(input.result.result.rows),
    };
    rows.push(rec);
    writeJsonFile(this.file, rows);
  }

  status(): { total: number; latest?: string } {
    const rows = this.list();
    return { total: rows.length, latest: rows.at(-1)?.resolvedAt };
  }

  compact(): { before: number; after: number } {
    const rows = this.list();
    const map = new Map<string, LearningRecord>();
    for (const row of rows) {
      const key = `${row.datasource}|${row.querySignature || ''}`;
      map.set(key, row);
    }
    const compacted = [...map.values()].sort((a, b) => String(a.resolvedAt).localeCompare(String(b.resolvedAt)));
    writeJsonFile(this.file, compacted);
    return { before: rows.length, after: compacted.length };
  }

  prune(ttlHours: number): { before: number; after: number } {
    const rows = this.list();
    const cutoff = Date.now() - ttlHours * 3600 * 1000;
    const kept = rows.filter((r) => new Date(r.resolvedAt).getTime() >= cutoff);
    writeJsonFile(this.file, kept);
    return { before: rows.length, after: kept.length };
  }

  clear(): void {
    writeJsonFile(this.file, []);
  }
}
