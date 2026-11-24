const HINT_DROP = 'drop it';
const UNKNOWN_OPTION_NAME = /unknown option '(?<name>[^'=]+)/u;
const UNKNOWN_COMMAND_NAME = /unknown command '(?<name>[^']+)'/u;
const HINT_ALWAYS_JSON = 'output is always one line of compact JSON; drop it';

const REMOVED_OPTIONS: Record<string, string> = {
  '--json': HINT_ALWAYS_JSON,
  '--jsonl': HINT_ALWAYS_JSON,
  '--no-color': HINT_ALWAYS_JSON,
  '--no-animations': HINT_ALWAYS_JSON,
  '--datetime-format': HINT_ALWAYS_JSON,
  '--full': 'query output is never truncated; drop it',
  '--reason': HINT_DROP,
  '--intent': 'pass the query text with --sql',
  '--timeout-ms': 'use --timeout <ms>',
  '--allow-schema-introspection': 'the schema catalog is fetched in the background; drop it',
  '--memory-root': 'use --kb-dir <dir> or TAPROOT_KB_DIR',
  '--skill-version': HINT_DROP,
  '--profile': HINT_DROP,
  '--verbose-detail': HINT_DROP,
  '--all': HINT_DROP,
  '--name': 'datasource show and remove take the name as an argument: taproot datasource show <name>',
  '--openvpn-ref': 'the openvpn connector was removed; use teleport or kubectl-portforward',
};

const REMOVED_COMMANDS: Record<string, string> = {
  learn: 'read table structure with taproot query --sql "SHOW CREATE TABLE <table>"',
  run: 'use taproot query',
  bench: HINT_DROP,
  discover: 'add a profile with taproot datasource add or taproot init datasource',
  session: 'the daemon manages sessions; just run taproot query',
  connector: 'use taproot doctor --datasource <name> --connect',
  'self-check': 'use taproot init for readiness or taproot doctor --datasource <name>',
  config: HINT_DROP,
  cache: HINT_DROP,
  sanitize: HINT_DROP,
  completion: HINT_DROP,
  start: 'the first taproot query starts the daemon',
  restart: 'run taproot daemon stop; the next query starts a fresh daemon',
  related: 'use taproot kb relations list [--cross-service]',
  'resolve-connection': 'use taproot kb resolve',
  'resolve-credentials': 'use taproot kb resolve',
  'resolve-database-name': 'use taproot kb resolve',
  export: 'use taproot datasource show <name> --pluck data',
  'migrate-to-fallback': HINT_DROP,
};

function removedHint(kind: 'option' | 'command', name: string, hint: string | undefined): string | undefined {
  return hint === undefined || hint === '' ? undefined : `${kind} '${name}' was removed in 1.0: ${hint}.`;
}

export function removedCliHint(commanderMessage: string): string | undefined {
  const option = UNKNOWN_OPTION_NAME.exec(commanderMessage)?.groups?.name;
  if (option !== undefined) {
    return removedHint('option', option, REMOVED_OPTIONS[option]);
  }
  const command = UNKNOWN_COMMAND_NAME.exec(commanderMessage)?.groups?.name;
  return command === undefined ? undefined : removedHint('command', command, REMOVED_COMMANDS[command]);
}
