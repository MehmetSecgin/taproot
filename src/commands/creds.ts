import type { Command } from 'commander';
import { collectRepeated } from '../cli/options.js';
import type { LocalExecutor } from '../cli/types.js';
import { parseKeyValuePairs } from '../core/key-value.js';
import { printSuccess } from '../core/output.js';

const PLAIN_CREDENTIAL_KEYS = ['user', 'dbUser', 'statusCommand', 'connectCommand', 'disconnectCommand', 'loginCommand'] as const;
const SECRET_CREDENTIAL_KEYS = ['password', 'token'] as const;
const STORED_CREDENTIAL_KEYS = [...PLAIN_CREDENTIAL_KEYS, ...SECRET_CREDENTIAL_KEYS];
const REDACTED_VALUE = '[REDACTED]';

type StoredCredentialKey = (typeof STORED_CREDENTIAL_KEYS)[number];
type CredsSetOptions = { ref: string; kv: string[] } & Partial<Record<StoredCredentialKey, string>>;
type CredsRefOptions = { ref: string };

function isPlainCredentialKey(key: string): boolean {
  return (PLAIN_CREDENTIAL_KEYS as readonly string[]).includes(key);
}

function credentialValuesFromOptions(opts: CredsSetOptions): Record<string, string> {
  const values = parseKeyValuePairs('--kv', opts.kv);
  for (const key of STORED_CREDENTIAL_KEYS) {
    const flagValue = opts[key];
    if (flagValue !== undefined && flagValue !== '') {
      values[key] = flagValue;
    }
  }
  return values;
}

export function credsCommand(program: Command, executor: LocalExecutor): void {
  const creds = program.command('creds').description('Credential reference management');

  creds.command('set')
    .description('Store credential values under a ref')
    .requiredOption('--ref <ref>', 'credential ref name; a datasource profile points to it with --credential-ref')
    .option('--user <user>', 'database user')
    .option('--db-user <dbUser>', 'Teleport database user (teleport-mysql)')
    .option('--password <password>', 'password')
    .option('--token <token>', 'bearer token sent as authorization metadata (grpc)')
    .option('--status-command <cmd>', 'connector: shell command that exits 0 when the connection is up')
    .option('--connect-command <cmd>', 'connector: shell command that brings the connection up')
    .option('--disconnect-command <cmd>', 'stored with the ref; no connector runs it')
    .option('--login-command <cmd>', 'teleport connector: shell command that logs in when the session expired')
    .option('--kv <key=value>', 'repeatable extra credential value', collectRepeated, [])
    .action(async (opts: CredsSetOptions) => {
      const ctx = executor.context();
      const values = credentialValuesFromOptions(opts);
      await ctx.credentialStore.set(opts.ref, values);
      printSuccess({ saved: true, ref: opts.ref, keys: Object.keys(values) });
    });

  creds.command('show').description('Show a credential ref with secrets redacted').requiredOption('--ref <ref>', 'credential ref name').action(async (opts: CredsRefOptions) => {
    const values = await executor.context().credentialStore.get(opts.ref);
    if (Object.keys(values).length === 0) {
      throw new Error(`Credential ref not found: ${opts.ref}`);
    }
    const redacted = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, isPlainCredentialKey(key) ? value : REDACTED_VALUE]),
    );
    printSuccess({ ref: opts.ref, values: redacted });
  });

  creds.command('list').description('List credential refs and their keys, secrets redacted').action(async () => {
    const entries = await executor.context().credentialStore.list();
    printSuccess(entries.map((entry) => ({ ref: entry.ref, keys: entry.keys, source: entry.source })));
  });

  creds.command('unset').description('Delete a credential ref').requiredOption('--ref <ref>', 'credential ref name').action(async (opts: CredsRefOptions) => {
    await executor.context().credentialStore.remove(opts.ref);
    printSuccess({ removed: true, ref: opts.ref });
  });
}
