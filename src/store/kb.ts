import path from 'node:path';
import { readJsonFile } from '../core/json.js';

export class KbStore {
  constructor(private readonly kbDir: string) {}

  private file(name: string): string {
    return path.join(this.kbDir, name);
  }

  services(): any[] {
    return readJsonFile<any[]>(this.file('services.json'), []);
  }

  templates(): any[] {
    return readJsonFile<any[]>(this.file('query-templates.json'), []);
  }

  relations(): any[] {
    return readJsonFile<any[]>(this.file('relations.json'), []);
  }

  tables(): any[] {
    return readJsonFile<any[]>(this.file('table-catalog.json'), []);
  }

  resolveConnection(service: string, env: string): Record<string, unknown> | null {
    const svc = this.services().find((s) => String(s.service || '').trim().toLowerCase() === service.toLowerCase());
    if (!svc) return null;
    const conns = Array.isArray(svc.connections) ? svc.connections : [];
    const active = conns.filter((c: any) => String(c.env) === env && String(c.status || 'active') === 'active');
    if (!active.length) return null;
    return active.sort((a: any, b: any) => String(b.verified_at_utc || '').localeCompare(String(a.verified_at_utc || '')))[0];
  }

  resolveQuery(service: string, intent: string): Record<string, unknown> | null {
    const normalized = intent.toLowerCase();
    const cands = this.templates().filter((t) => String(t.service || '').toLowerCase() === service.toLowerCase() && String(t.status || 'active') === 'active');
    if (!cands.length) return null;
    const ranked = cands
      .map((t) => ({
        t,
        exact: Number(String(t.intent || '').toLowerCase() === normalized),
        aliasExact: Number((Array.isArray(t.aliases) ? t.aliases : []).some((a: string) => String(a).toLowerCase() === normalized)),
        contains: Number(
          String(t.intent || '').toLowerCase().includes(normalized) ||
            normalized.includes(String(t.intent || '').toLowerCase()) ||
            (Array.isArray(t.aliases) ? t.aliases : []).some(
              (a: string) => String(a).toLowerCase().includes(normalized) || normalized.includes(String(a).toLowerCase()),
            ),
        ),
      }))
      .sort((a, b) => b.exact - a.exact || b.aliasExact - a.aliasExact || b.contains - a.contains || String(a.t.id || '').localeCompare(String(b.t.id || '')));
    if (!ranked[0].exact && !ranked[0].aliasExact && !ranked[0].contains) return null;
    return ranked[0].t;
  }
}
