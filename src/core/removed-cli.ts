const DROP = 'drop it';
const ALWAYS_JSON = 'output is always one line of compact JSON; drop it';

const REMOVED_OPTIONS: Record<string, string> = {
  '--json': ALWAYS_JSON,
  '--jsonl': ALWAYS_JSON,
  '--no-color': ALWAYS_JSON,
  '--no-animations': ALWAYS_JSON,
  '--datetime-format': ALWAYS_JSON,
  '--full': 'query output is never truncated; drop it',
  '--reason': DROP,
  '--intent': 'pass the query text with --sql',
  '--timeout-ms': 'use --timeout <ms>',
  '--allow-schema-introspection': 'the schema catalog is fetched in the background; drop it',
  '--memory-root': 'use --kb-dir <dir> or TAPROOT_KB_DIR',
  '--skill-version': DROP,
  '--profile': DROP,
  '--verbose-detail': DROP,
  '--all': DROP,
  '--name': 'datasource show and remove take the name as an argument: taproot datasource show <name>',
  '--openvpn-ref': 'the openvpn connector was removed; use teleport or kubectl-portforward',
};

const REMOVED_COMMANDS: Record<string, string> = {
  learn: 'read table structure with taproot query --sql "SHOW CREATE TABLE <table>"',
  run: 'use taproot query',
  bench: DROP,
  discover: 'add a profile with taproot datasource add or taproot init datasource',
  session: 'the daemon manages sessions; just run taproot query',
  connector: 'use taproot doctor --datasource <name> --connect',
  'self-check': 'use taproot init for readiness or taproot doctor --datasource <name>',
  config: DROP,
  cache: DROP,
  sanitize: DROP,
  completion: DROP,
  start: 'the first taproot query starts the daemon',
  restart: 'run taproot daemon stop; the next query starts a fresh daemon',
  related: 'use taproot kb relations list [--cross-service]',
  'resolve-connection': 'use taproot kb resolve',
  'resolve-credentials': 'use taproot kb resolve',
  'resolve-database-name': 'use taproot kb resolve',
  export: 'use taproot datasource show <name> --pluck data',
  'migrate-to-fallback': DROP,
};

export function removedCliHint(commanderMessage: string): string | undefined {
  const option = commanderMessage.match(/unknown option '([^'=]+)/)?.[1];
  const command = commanderMessage.match(/unknown command '([^']+)'/)?.[1];
  const name = option ?? command;
  const hint = option ? REMOVED_OPTIONS[option] : command ? REMOVED_COMMANDS[command] : undefined;
  return name && hint ? `${option ? 'option' : 'command'} '${name}' was removed in 1.0: ${hint}.` : undefined;
}
