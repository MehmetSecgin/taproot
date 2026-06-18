import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { fillTemplate, parseParamPairs } from '../core/app.js';
import { EXIT_CODES } from '../core/exit-codes.js';
import { nowIso } from '../core/time.js';
import { printJson, renderRecord, renderTable } from '../core/output.js';
import { TemplateStatus } from '../types/core.js';

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

export function registerTemplate(program: Command, getCtx: () => AppContext): void {
  const t = program.command('template').description('Query template operations');

  t.command('list').action(() => {
    const ctx = getCtx();
    const rows = ctx.templateStore.list();
    if (ctx.jsonMode) printJson(rows);
    else console.log(renderTable(rows.map((r) => ({ id: r.id, intent: r.intent, datasource: r.datasourceName || r.datasourceKind || '', status: r.status }))));
  });

  t.command('validate').requiredOption('--id <id>').action((opts) => {
    const ctx = getCtx();
    const item = ctx.templateStore.get(opts.id);
    if (!item) throw new Error(`Template not found: ${opts.id}`);
    const placeholders = [...item.nativeQueryTemplate.matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((m) => m[1]);
    const missing = item.params.filter((p) => !placeholders.includes(p));
    const extra = placeholders.filter((p) => !item.params.includes(p));
    const valid = missing.length === 0 && extra.length === 0;
    if (ctx.jsonMode) printJson({ valid, missingParams: missing, extraPlaceholders: extra });
    else {
      console.log(renderRecord({ id: item.id, valid, missingParams: missing, extraPlaceholders: extra }));
    }
    if (!valid) process.exit(EXIT_CODES.BAD_INPUT);
  });

  t.command('run').requiredOption('--id <id>').option('--param <key=value>', 'repeatable', (v, p: string[]) => (p || []).concat(v), []).action((opts) => {
    const ctx = getCtx();
    const item = ctx.templateStore.get(opts.id);
    if (!item) throw new Error(`Template not found: ${opts.id}`);
    const params = parseParamPairs(opts.param || []);
    const unknownParams = Object.keys(params).filter((key) => !item.params.includes(key));
    if (unknownParams.length) throw new Error(`Invalid argument: Unknown --param for template ${item.id}: ${unknownParams.join(', ')}`);
    const query = fillTemplate(item.nativeQueryTemplate, params);
    if (ctx.jsonMode) printJson({ id: item.id, query });
    else {
      console.log(`template: ${item.id}`);
      console.log(query);
    }
  });

  t.command('save')
    .requiredOption('--id <id>')
    .requiredOption('--intent <intent>')
    .requiredOption('--query <query>')
    .option('--datasource-name <name>')
    .option('--datasource-kind <kind>')
    .option('--alias <name>', 'repeatable', (v, p: string[]) => (p || []).concat(v), [])
    .action((opts) => {
      const ctx = getCtx();
      const saved = ctx.templateStore.save({
        id: opts.id,
        intent: opts.intent,
        aliases: opts.alias || [],
        nativeQueryTemplate: opts.query,
        params: extractTemplateParams(opts.query),
        datasourceName: opts.datasourceName,
        datasourceKind: opts.datasourceKind,
        resultShape: 'table',
        tags: [],
        status: TemplateStatus.Active,
        verifiedAt: nowIso(),
      } as any);
      if (ctx.jsonMode) printJson(saved);
      else console.log(`Saved template ${saved.id}`);
    });
}
