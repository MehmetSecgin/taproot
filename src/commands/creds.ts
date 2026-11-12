import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { parseKeyValuePairs } from '../core/key-value.js';
import { printEnvelope } from '../core/output.js';

const PLAIN_CREDENTIAL_KEYS = ['user', 'dbUser', 'statusCommand', 'connectCommand', 'disconnectCommand', 'loginCommand'];
const SECRET_CREDENTIAL_KEYS = ['password', 'token'];

export function registerCreds(program: Command, getCtx: () => AppContext): void {
  const c = program.command('creds').description('Credential reference management');

  c.command('set')
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
    .option('--kv <key=value>', 'repeatable extra credential value', (v, p: string[]) => (p || []).concat(v), [])
    .action(async (opts) => {
      const ctx = getCtx();
      const value = parseKeyValuePairs('--kv', opts.kv || []);
      for (const key of [...PLAIN_CREDENTIAL_KEYS, ...SECRET_CREDENTIAL_KEYS]) {
        if (opts[key]) value[key] = String(opts[key]);
      }
      await ctx.credentialStore.set(opts.ref, value);
      printEnvelope(true, { saved: true, ref: opts.ref, keys: Object.keys(value) });
    });

  c.command('show').description('Show a credential ref with secrets redacted').requiredOption('--ref <ref>', 'credential ref name').action(async (opts) => {
    const ctx = getCtx();
    const value = await ctx.credentialStore.get(opts.ref);
    if (!Object.keys(value).length) throw new Error(`Credential ref not found: ${opts.ref}`);
    const redacted = Object.fromEntries(
      Object.entries(value).map(([key, val]) => [key, PLAIN_CREDENTIAL_KEYS.includes(key) ? val : '[REDACTED]']),
    );
    printEnvelope(true, { ref: opts.ref, values: redacted });
  });

  c.command('list').description('List credential refs and their keys, secrets redacted').action(async () => {
    const ctx = getCtx();
    const entries = await ctx.credentialStore.list();
    printEnvelope(true, entries.map((e) => ({ ref: e.ref, keys: e.keys, source: e.source })));
  });

  c.command('unset').description('Delete a credential ref').requiredOption('--ref <ref>', 'credential ref name').action(async (opts) => {
    const ctx = getCtx();
    await ctx.credentialStore.remove(opts.ref);
    printEnvelope(true, { removed: true, ref: opts.ref });
  });

}
