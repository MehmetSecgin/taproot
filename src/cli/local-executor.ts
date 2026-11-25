import type { Command } from 'commander';
import { buildContext } from '../core/app.js';
import type { AppContext } from '../core/app.js';
import { DATASOURCE_COLUMNS, listDatasources } from '../core/datasource-list.js';
import type { TapRootPlugin } from '../types/plugin.js';
import { runLocalQuery } from './local-query.js';
import { readLocalSchema } from './local-schema.js';
import type { LocalExecutor } from './types.js';
import { emptyToUndefined } from '../core/text-presence.js';

type GlobalCliOptions = { kbDir?: string; verbose?: boolean };

const NO_PROFILE_FILTER = undefined;

export function localExecutor(input: { plugins: TapRootPlugin[] }): LocalExecutor {
  const programRef: { current?: Command } = {};

  const context = (): AppContext => {
    const globalOptions: GlobalCliOptions = programRef.current?.opts<GlobalCliOptions>() ?? {};
    return buildContext({
      kbDir: emptyToUndefined(globalOptions.kbDir),
      verbose: Boolean(globalOptions.verbose),
      plugins: input.plugins,
      useKeychain: true,
    });
  };

  return {
    context,

    addOptions(target) {
      programRef.current = target;
      target
        .option('--kb-dir <path>', 'Path to the KB directory (containing services.json). Overrides TAPROOT_KB_DIR and the directory saved by `taproot init --kb-dir`.')
        .option('--verbose', 'Diagnostics on stderr as JSON lines', false);
    },

    async query(opts) {
      return runLocalQuery(context(), opts);
    },

    async listDatasources(request) {
      return listDatasources(context(), request, { columns: DATASOURCE_COLUMNS, filter: NO_PROFILE_FILTER });
    },

    async readSchema(request) {
      return readLocalSchema(context(), request);
    },
  };
}
