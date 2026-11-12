import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { badInput } from '../core/error-classification.js';
import { printEnvelope } from '../core/output.js';

const PLAIN_CREDENTIAL_KEYS = new Set(['user', 'dbUser', 'statusCommand', 'connectCommand', 'disconnectCommand', 'loginCommand']);

function parseKv(values: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values) {
    const idx = value.indexOf('=');
    if (idx <= 0) throw badInput(`Invalid --kv '${value}'. Expected key=value.`);
    const key = value.slice(0, idx).trim();
    const val = value.slice(idx + 1);
    if (!key) throw badInput(`Invalid --kv '${value}'. Key cannot be empty.`);
    out[key] = val;
  }
  return out;
}

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
      const value: Record<string, string> = parseKv(opts.kv || []);
      for (const k of [
        'user',
        'dbUser',
        'password',
        'token',
        'statusCommand',
        'connectCommand',
        'disconnectCommand',
        'loginCommand',
      ] as const) {
        if (opts[k]) value[k] = String(opts[k]);
      }
      await ctx.credentialStore.set(opts.ref, value);
      printEnvelope(true, { saved: true, ref: opts.ref, keys: Object.keys(value) });
    });

  c.command('show').description('Show a credential ref with secrets redacted').requiredOption('--ref <ref>', 'credential ref name').action(async (opts) => {
    const ctx = getCtx();
    const value = await ctx.credentialStore.get(opts.ref);
    if (!Object.keys(value).length) throw new Error(`Credential ref not found: ${opts.ref}`);
    const redacted = Object.fromEntries(
      Object.entries(value).map(([key, val]) => [key, PLAIN_CREDENTIAL_KEYS.has(key) ? val : '[REDACTED]']),
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
