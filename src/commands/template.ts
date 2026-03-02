import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { fillTemplate, parseParamPairs } from '../core/app.js';
import { nowIso } from '../core/time.js';
import { printJson, renderTable } from '../core/output.js';

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
    const valid = missing.length === 0;
    printJson({ valid, missingParams: missing, extraPlaceholders: extra });
    if (!valid) process.exitCode = 1;
  });

  t.command('run').requiredOption('--id <id>').option('--param <key=value>', 'repeatable', (v, p: string[]) => (p || []).concat(v), []).action((opts) => {
    const ctx = getCtx();
    const item = ctx.templateStore.get(opts.id);
    if (!item) throw new Error(`Template not found: ${opts.id}`);
    const params = parseParamPairs(opts.param || []);
    const query = fillTemplate(item.nativeQueryTemplate, params);
    printJson({ id: item.id, query });
  });

  t.command('save')
    .requiredOption('--id <id>')
    .requiredOption('--intent <intent>')
    .requiredOption('--query <query>')
    .option('--datasource-name <name>')
    .option('--datasource-kind <kind>')
    .option('--param <name>', 'repeatable', (v, p: string[]) => (p || []).concat(v), [])
    .action((opts) => {
      const ctx = getCtx();
      const saved = ctx.templateStore.save({
        id: opts.id,
        intent: opts.intent,
        nativeQueryTemplate: opts.query,
        params: opts.param || [],
        datasourceName: opts.datasourceName,
        datasourceKind: opts.datasourceKind,
        resultShape: 'table',
        tags: [],
        status: 'active',
        verifiedAt: nowIso(),
      } as any);
      printJson(saved);
    });
}
