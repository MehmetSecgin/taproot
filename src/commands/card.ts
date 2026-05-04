import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { printJson, renderRecord, renderTable } from '../core/output.js';

export function registerCard(program: Command, getCtx: () => AppContext): void {
  const card = program.command('card').description('Curated query card operations');

  card
    .command('list')
    .option('--datasource <name>')
    .action((opts) => {
      const ctx = getCtx();
      const rows = ctx.cardStore
        .list()
        .filter((item) => !opts.datasource || item.datasource === opts.datasource);
      if (ctx.jsonMode) printJson(rows);
      else {
        console.log(
          renderTable(
            rows.map((item) => ({
              id: item.id,
              datasource: item.datasource || '',
              intent: item.intent || '',
              tables: item.tables.join(', '),
              purpose: item.purpose,
            })),
          ),
        );
      }
    });

  card
    .command('show')
    .argument('<id>')
    .action((id) => {
      const ctx = getCtx();
      const item = ctx.cardStore.get(id);
      if (!item) throw new Error(`Query card not found: ${id}`);
      if (ctx.jsonMode) printJson(item);
      else console.log(renderRecord(item as unknown as Record<string, unknown>));
    });

  card
    .command('validate')
    .argument('<path>')
    .action((filePath) => {
      const ctx = getCtx();
      const item = ctx.cardStore.validateFile(filePath);
      if (ctx.jsonMode) printJson({ ok: true, card: item });
      else console.log(`valid query card: ${item.id}`);
    });
}
