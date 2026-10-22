import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { printJson } from '../core/output.js';

export function registerCache(program: Command, getCtx: () => AppContext): void {
  const c = program.command('cache').description('Schema catalog cache commands');

  c.command('show').description('List the cached schema catalog per datasource').action(() => {
    printJson({ catalogs: getCtx().schemaCatalogStore.list() });
  });

  c.command('clear').description('Delete every cached schema catalog; the next query per datasource refetches it').action(() => {
    printJson({ cleared: getCtx().schemaCatalogStore.clear() });
  });
}
