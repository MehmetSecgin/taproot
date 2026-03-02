import { readJsonFile, writeJsonFile } from '../core/json.js';
import type { QueryTemplate } from '../types/core.js';
import { QueryTemplateListSchema } from './schemas.js';

export class TemplateStore {
  constructor(private readonly file: string) {}

  list(): QueryTemplate[] {
    const raw = readJsonFile<unknown>(this.file, []);
    const parsed = QueryTemplateListSchema.safeParse(raw);
    return parsed.success ? (parsed.data as QueryTemplate[]) : [];
  }

  get(id: string): QueryTemplate | undefined {
    return this.list().find((t) => t.id === id);
  }

  save(template: QueryTemplate): QueryTemplate {
    const all = this.list().filter((t) => t.id !== template.id);
    all.push(template);
    writeJsonFile(this.file, all);
    return template;
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
        contains: Number(t.intent.toLowerCase().includes(normalized) || normalized.includes(t.intent.toLowerCase())),
        tags: t.tags.filter((tag) => normalized.includes(tag.toLowerCase())).length,
      }))
      .sort((a, b) => b.exact - a.exact || b.contains - a.contains || b.tags - a.tags || a.t.id.localeCompare(b.t.id));
    if (scored[0].exact || scored[0].contains || scored[0].tags) return scored[0].t;
    return undefined;
  }
}
