import { readJsonFile, writeJsonFile } from '../core/json.js';
import type { QueryTemplate } from '../types/core.js';
import { QueryTemplateListSchema } from './schemas.js';

function extractTemplateParams(sql: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of sql.matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
    const key = m[1];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function normalizeTemplate(input: QueryTemplate): QueryTemplate {
  const aliases = Array.from(new Set((input.aliases || []).map((a) => a.trim()).filter(Boolean)));
  const params = extractTemplateParams(input.nativeQueryTemplate);
  return {
    ...input,
    aliases,
    params,
  };
}

export class TemplateStore {
  constructor(private readonly file: string) {}

  list(): QueryTemplate[] {
    const raw = readJsonFile<unknown>(this.file, []);
    const parsed = QueryTemplateListSchema.safeParse(raw);
    if (!parsed.success) return [];
    const normalized = (parsed.data as QueryTemplate[]).map((t) => normalizeTemplate(t));
    if (JSON.stringify(normalized) !== JSON.stringify(parsed.data)) writeJsonFile(this.file, normalized);
    return normalized;
  }

  get(id: string): QueryTemplate | undefined {
    return this.list().find((t) => t.id === id);
  }

  save(template: QueryTemplate): QueryTemplate {
    const normalized = normalizeTemplate(template);
    const all = this.list().filter((t) => t.id !== template.id);
    all.push(normalized);
    writeJsonFile(this.file, all);
    return normalized;
  }

  resolveByIntent(input: { datasourceName?: string; datasourceKind?: string; intent: string }): QueryTemplate | undefined {
    const normalized = input.intent.trim().toLowerCase();
    const candidates = this.list().filter((t) => {
      if (t.status !== 'active') return false;
      if (input.datasourceName && t.datasourceName && t.datasourceName !== input.datasourceName) return false;
      if (input.datasourceKind && t.datasourceKind && t.datasourceKind !== input.datasourceKind) return false;
      return true;
    });
    if (!candidates.length) return undefined;
    const scored = candidates
      .map((t) => ({
        t,
        exact: Number(t.intent.toLowerCase() === normalized),
        aliasExact: Number((t.aliases || []).some((a) => a.toLowerCase() === normalized)),
        contains: Number(
          t.intent.toLowerCase().includes(normalized) ||
            normalized.includes(t.intent.toLowerCase()) ||
            (t.aliases || []).some((a) => a.toLowerCase().includes(normalized) || normalized.includes(a.toLowerCase())),
        ),
        tags: t.tags.filter((tag) => normalized.includes(tag.toLowerCase())).length,
      }))
      .sort((a, b) => b.exact - a.exact || b.aliasExact - a.aliasExact || b.contains - a.contains || b.tags - a.tags || a.t.id.localeCompare(b.t.id));
    if (scored[0].exact || scored[0].aliasExact || scored[0].contains || scored[0].tags) return scored[0].t;
    return undefined;
  }
}
