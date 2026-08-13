import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { badInput } from '../core/error-classification.js';
import { printJson, renderRecord, renderTable } from '../core/output.js';

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
      const out = { saved: true, ref: opts.ref, keys: Object.keys(value) };
      if (ctx.jsonMode) printJson(out);
      else console.log(`saved credential ref ${out.ref} (${out.keys.length} keys)`);
    });

  c.command('show').requiredOption('--ref <ref>').action(async (opts) => {
    const ctx = getCtx();
    const value = await ctx.credentialStore.get(opts.ref);
    if (!Object.keys(value).length) throw new Error(`Credential ref not found: ${opts.ref}`);
    const redacted = { ...value };
    if (redacted.password) redacted.password = '[REDACTED]';
    if (redacted.token) redacted.token = '[REDACTED]';
    if (ctx.jsonMode) printJson({ ref: opts.ref, values: redacted });
    else console.log(renderRecord({ ref: opts.ref, ...redacted }));
  });

  c.command('list').action(async () => {
    const ctx = getCtx();
    const entries = await ctx.credentialStore.list();
    if (ctx.jsonMode) {
      printJson(entries.map((e) => ({ ref: e.ref, keys: e.keys, source: e.source })));
      return;
    }
    const rows = entries.map((e) => ({ ref: e.ref, source: e.source, keys: e.keys.join(',') }));
    console.log(renderTable(rows));
  });

  c.command('unset').requiredOption('--ref <ref>').action(async (opts) => {
    const ctx = getCtx();
    await ctx.credentialStore.remove(opts.ref);
    if (ctx.jsonMode) printJson({ removed: true, ref: opts.ref });
    else console.log(`removed credential ref ${opts.ref}`);
  });

  c.command('migrate-to-fallback')
    .description('Copy every keychain-stored credential into the encrypted fallback file and delete the keychain copy. Stops macOS keychain ACL prompts on each rebuilt binary. After migration, set TAPROOT_NO_KEYCHAIN=1 to keep new creds out of keychain too.')
    .action(async () => {
      const ctx = getCtx();
      const store = ctx.credentialStore as unknown as { migrateKeychainToFallback?: () => Promise<{ migrated: string[]; failed: Array<{ ref: string; reason: string }>; alreadyInFallback: string[] }> };
      if (typeof store.migrateKeychainToFallback !== 'function') {
        throw new Error('Credential store does not support migrateKeychainToFallback in this build.');
      }
      const result = await store.migrateKeychainToFallback();
      const summary = {
        migrated: result.migrated,
        alreadyInFallback: result.alreadyInFallback,
        failed: result.failed,
        nextSteps: [
          'export TAPROOT_NO_KEYCHAIN=1 (skip keychain entirely for future reads/writes)',
          'taproot creds list (verify all refs now show source=fallback)',
        ],
      };
      if (ctx.jsonMode) printJson(summary);
      else {
        console.log(`migrated ${result.migrated.length} refs from keychain to fallback file`);
        if (result.alreadyInFallback.length) console.log(`overlapped with existing fallback entries: ${result.alreadyInFallback.join(', ')}`);
        if (result.failed.length) {
          console.log('failures:');
          for (const item of result.failed) console.log(`- ${item.ref}: ${item.reason}`);
        }
        console.log('next: export TAPROOT_NO_KEYCHAIN=1');
      }
    });
}
