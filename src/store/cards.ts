import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { z } from 'zod';
import type { QueryCard, QueryCardMatch } from '../types/cards.js';
import type { RuntimeConfigStore } from './runtime-config.js';

const CardParamSchema = z.union([
  z.string().transform((name) => ({ name })),
  z.object({
    name: z.string().min(1),
    type: z.string().optional(),
    required: z.boolean().optional(),
    description: z.string().optional(),
    default: z.unknown().optional(),
  }),
]);

const QueryCardSchema = z.object({
  id: z.string().min(1),
  datasource: z.string().optional(),
  kind: z.string().optional(),
  purpose: z.string().min(1),
  intent: z.string().optional(),
  aliases: z.array(z.string()).default([]),
  tables: z.array(z.string()).default([]),
  requires: z.object({
    partition_predicates: z.record(z.string(), z.array(z.string())).optional(),
    must_filter: z.array(z.string()).optional(),
    max_range_days: z.number().int().positive().optional(),
  }).optional(),
  forbids: z.array(z.string()).default([]),
  sql: z.string().min(1),
  params: z.array(CardParamSchema).default([]),
  notes: z.array(z.string()).default([]),
  indexes_considered: z.array(z.string()).default([]),
  owners: z.array(z.string()).default([]),
  verified_at: z.string().optional(),
});

const require = createRequire(import.meta.url);

function parseYaml(text: string): unknown {
  const yaml = require('yaml') as { parse: (input: string) => unknown };
  return yaml.parse(text);
}

export function stringifyQueryCard(card: QueryCard): string {
  const yaml = require('yaml') as { stringify: (input: unknown, opts?: Record<string, unknown>) => string };
  const out: Record<string, unknown> = {
    id: card.id,
    ...(card.datasource ? { datasource: card.datasource } : {}),
    ...(card.kind ? { kind: card.kind } : {}),
    purpose: card.purpose,
    ...(card.intent ? { intent: card.intent } : {}),
    aliases: card.aliases || [],
    tables: card.tables || [],
    ...(card.requires ? { requires: card.requires } : {}),
    forbids: card.forbids || [],
    sql: card.sql,
    params: card.params || [],
    notes: card.notes || [],
    indexes_considered: card.indexes_considered || [],
    owners: card.owners || [],
    ...(card.verified_at ? { verified_at: card.verified_at } : {}),
  };
  return yaml.stringify(out, { lineWidth: 120 });
}

export interface CardStoreOptions {
  repoRoot?: string;
  stateRoot: string;
  runtimeConfigStore: Pick<RuntimeConfigStore, 'cardRoots'>;
}

function expandPath(input: string, repoRoot: string): string {
  const value = input.trim();
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  if (path.isAbsolute(value)) return value;
  return path.join(repoRoot, value);
}

function walkYamlFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const stat = fs.statSync(root);
  if (stat.isFile()) return /\.(ya?ml)$/i.test(root) ? [root] : [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkYamlFiles(fullPath));
    else if (entry.isFile() && /\.(ya?ml)$/i.test(entry.name)) out.push(fullPath);
  }
  return out;
}

function tableBare(value: string): string {
  return String(value || '').trim().toLowerCase().split('.').pop() || '';
}

function normalizeText(value?: string): string {
  return String(value || '').trim().toLowerCase();
}

export class CardStore {
  private cards: QueryCard[] = [];
  private loaded = false;
  private signature = '';

  constructor(private readonly opts: CardStoreOptions) {}

  roots(): string[] {
    const repoRoot = this.opts.repoRoot || process.cwd();
    const defaults = [
      path.join(repoRoot, 'queries'),
      path.join(repoRoot, 'modules'),
      path.join(repoRoot, 'services'),
      path.join(this.opts.stateRoot, 'cards'),
    ];
    const configured = this.opts.runtimeConfigStore.cardRoots().map((item) => expandPath(item, repoRoot));
    return Array.from(new Set([...defaults, ...configured]));
  }

  private discoverFiles(): string[] {
    const files: string[] = [];
    for (const root of this.roots()) {
      if (root.endsWith(`${path.sep}modules`) || root.endsWith(`${path.sep}services`)) {
        if (!fs.existsSync(root)) continue;
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
          if (entry.isDirectory()) files.push(...walkYamlFiles(path.join(root, entry.name, 'queries')));
        }
      } else {
        files.push(...walkYamlFiles(root));
      }
    }
    return Array.from(new Set(files)).sort((a, b) => a.localeCompare(b));
  }

  private currentSignature(files: string[]): string {
    return files
      .map((file) => {
        try {
          const stat = fs.statSync(file);
          return `${file}:${stat.mtimeMs}:${stat.size}`;
        } catch {
          return `${file}:missing`;
        }
      })
      .join('|');
  }

  reloadIfNeeded(): void {
    const files = this.discoverFiles();
    const signature = this.currentSignature(files);
    if (this.loaded && signature === this.signature) return;
    const next: QueryCard[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      const card = this.validateFile(file);
      if (seen.has(card.id)) {
        throw new Error(`Duplicate query card id '${card.id}' in ${file}`);
      }
      seen.add(card.id);
      next.push(card);
    }
    this.cards = next.sort((a, b) => a.id.localeCompare(b.id));
    this.signature = signature;
    this.loaded = true;
  }

  validateFile(filePath: string): QueryCard {
    const parsed = QueryCardSchema.safeParse(parseYaml(fs.readFileSync(filePath, 'utf8')));
    if (!parsed.success) {
      throw new Error(`Invalid query card ${filePath}: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
    }
    return {
      ...parsed.data,
      aliases: Array.from(new Set(parsed.data.aliases.map((item) => item.trim()).filter(Boolean))),
      tables: Array.from(new Set(parsed.data.tables.map((item) => item.trim()).filter(Boolean))),
      forbids: Array.from(new Set(parsed.data.forbids.map((item) => item.trim()).filter(Boolean))),
      notes: parsed.data.notes.map((item) => String(item || '').trim()).filter(Boolean),
      indexes_considered: parsed.data.indexes_considered.map((item) => String(item || '').trim()).filter(Boolean),
      owners: parsed.data.owners.map((item) => String(item || '').trim()).filter(Boolean),
      params: parsed.data.params.map((param) => ({ ...param, name: param.name.trim() })).filter((param) => param.name),
      sourcePath: filePath,
    };
  }

  list(): QueryCard[] {
    this.reloadIfNeeded();
    return [...this.cards];
  }

  get(id: string): QueryCard | undefined {
    this.reloadIfNeeded();
    return this.cards.find((card) => card.id === id);
  }

  match(input: { datasource?: string; env?: string; service?: string; intent?: string; tables?: string[] }): QueryCardMatch[] {
    this.reloadIfNeeded();
    const intent = normalizeText(input.intent);
    const tables = new Set((input.tables || []).map(tableBare).filter(Boolean));
    const datasource = normalizeText(input.datasource);
    const scored = this.cards
      .map((card): QueryCardMatch => {
        const reasons: string[] = [];
        let score = 0;
        if (datasource && normalizeText(card.datasource) === datasource) {
          score += 20;
          reasons.push('datasource');
        }
        if (intent && normalizeText(card.intent) === intent) {
          score += 15;
          reasons.push('intent');
        }
        if (intent && card.aliases.some((alias) => normalizeText(alias) === intent)) {
          score += 12;
          reasons.push('alias');
        }
        if (intent && card.purpose.toLowerCase().includes(intent)) {
          score += 5;
          reasons.push('purpose');
        }
        const overlap = card.tables.filter((table) => tables.has(tableBare(table))).length;
        if (overlap) {
          score += overlap * 4;
          reasons.push('tables');
        }
        return { card, score, reasons };
      })
      .filter((match) => match.score > 0)
      .sort((a, b) => b.score - a.score || a.card.id.localeCompare(b.card.id));
    return scored;
  }
}
