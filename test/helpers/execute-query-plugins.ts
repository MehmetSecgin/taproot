import { fakePlugin, wrapExecute } from './fake-plugin.js';
import type { TapRootPlugin } from '../../src/types/plugin.js';

export function catalogGatedPlugin(gate: Promise<void>, catalogQueries: string[]): TapRootPlugin {
  return wrapExecute(fakePlugin({ kind: 'mysql' }), (inner) => async (request, creds) => {
    if (request.query.includes('information_schema')) {
      catalogQueries.push(request.query);
      await gate;
    }
    return inner(request, creds);
  });
}

export function unknownColumnPlugin(catalogQueries: string[]): TapRootPlugin {
  return wrapExecute(fakePlugin({ kind: 'mysql' }), (inner) => async (request, creds) => {
    if (!request.query.includes('information_schema')) {
      throw new Error("Unknown column 'customer_ident' in 'field list'");
    }
    catalogQueries.push(request.query);
    return inner(request, creds);
  });
}
