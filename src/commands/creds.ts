import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { printJson } from '../core/output.js';

function parseKv(values: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values) {
    const idx = value.indexOf('=');
    if (idx <= 0) throw new Error(`Invalid --kv '${value}'. Expected key=value.`);
    const key = value.slice(0, idx).trim();
    const val = value.slice(idx + 1);
    if (!key) throw new Error(`Invalid --kv '${value}'. Key cannot be empty.`);
    out[key] = val;
  }
  return out;
}

export function registerCreds(program: Command, getCtx: () => AppContext): void {
  const c = program.command('creds').description('Credential reference management');

  c.command('set')
    .requiredOption('--ref <ref>')
    .option('--user <user>')
    .option('--db-user <dbUser>')
    .option('--password <password>')
    .option('--token <token>')
    .option('--status-command <cmd>')
    .option('--connect-command <cmd>')
    .option('--disconnect-command <cmd>')
    .option('--login-command <cmd>')
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
      printJson({ saved: true, ref: opts.ref, keys: Object.keys(value) });
    });

  c.command('show').requiredOption('--ref <ref>').action(async (opts) => {
    const ctx = getCtx();
    const value = await ctx.credentialStore.get(opts.ref);
    const redacted = { ...value };
    if (redacted.password) redacted.password = '[REDACTED]';
    if (redacted.token) redacted.token = '[REDACTED]';
    printJson({ ref: opts.ref, values: redacted });
  });

  c.command('unset').requiredOption('--ref <ref>').action(async (opts) => {
    const ctx = getCtx();
    await ctx.credentialStore.remove(opts.ref);
    printJson({ removed: true, ref: opts.ref });
  });
}
