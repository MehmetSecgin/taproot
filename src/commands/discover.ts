import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { printJson, renderTable } from '../core/output.js';
import {
  applyProposals,
  classifyKubeService,
  classifyTshDatabase,
  fetchKubeServices,
  fetchTshDatabases,
  type DiscoveryMode,
  type DiscoveryProposal,
} from '../core/discover-datasources.js';

function renderProposals(proposals: DiscoveryProposal[]): string {
  if (!proposals.length) return '(no proposals)';
  return renderTable(
    proposals.map((p) => ({
      name: p.name,
      kind: p.kind,
      env: p.env,
      service: p.service,
      namespace: p.namespace || '',
      host: p.connection.host || '',
      port: p.connection.port ?? '',
      target: p.connection.target || '',
      credentialRef: p.credentialRef,
      connectors: p.connectors.join(',') || '',
      conf: p.confidence.toFixed(2),
      reason: p.reason,
    })),
  );
}

function parseMode(value: string | undefined, fallback: DiscoveryMode): DiscoveryMode {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'native' || v === 'qa-portforward' || v === 'tsh') return v;
  return fallback;
}

export function registerDiscover(program: Command, getCtx: () => AppContext): void {
  const discover = program
    .command('discover')
    .description('Discover candidate datasources from local tooling (kubectl, tsh)');

  discover
    .command('kubectl')
    .description('Scan kubectl-visible services for DB-shaped candidates')
    .requiredOption('--env <env>', 'Environment tag to assign to discovered datasources')
    .option('--namespace <namespace>', 'Limit scan to a single namespace (default: all namespaces)')
    .option('--context <context>', 'kubectl context (defaults to current)')
    .option('--mode <mode>', 'native|qa-portforward (default native)', 'native')
    .option('--apply', 'Save proposals into the local datasource store', false)
    .option('--force', 'Overwrite existing datasource profiles with the same name', false)
    .action((opts) => {
      const ctx = getCtx();
      const mode = parseMode(opts.mode, 'native');
      const fetched = fetchKubeServices({ namespace: opts.namespace, context: opts.context });
      if (!fetched.ok) {
        if (ctx.jsonMode) printJson({ ok: false, source: 'kubectl', error: fetched.detail });
        else console.error(`kubectl scan failed: ${fetched.detail}`);
        process.exitCode = 1;
        return;
      }
      const aliases = ctx.runtimeConfigStore.serviceAliases();
      const proposals = fetched.services
        .map((svc) => classifyKubeService(svc, { env: opts.env, mode, aliases }))
        .filter((p): p is DiscoveryProposal => Boolean(p));
      runApplyOrPrint(ctx, proposals, { apply: Boolean(opts.apply), force: Boolean(opts.force), source: 'kubectl', detail: fetched.detail });
    });

  discover
    .command('teleport')
    .description('Scan `tsh db ls` for DB datasources')
    .requiredOption('--env <env>')
    .option('--apply', 'Save proposals into the local datasource store', false)
    .option('--force', 'Overwrite existing datasource profiles with the same name', false)
    .action((opts) => {
      const ctx = getCtx();
      const fetched = fetchTshDatabases();
      if (!fetched.ok) {
        if (ctx.jsonMode) printJson({ ok: false, source: 'teleport', error: fetched.detail });
        else console.error(`tsh scan failed: ${fetched.detail}`);
        process.exitCode = 1;
        return;
      }
      const aliases = ctx.runtimeConfigStore.serviceAliases();
      const proposals = fetched.databases
        .map((db) => classifyTshDatabase(db, { env: opts.env, aliases }))
        .filter((p): p is DiscoveryProposal => Boolean(p));
      runApplyOrPrint(ctx, proposals, { apply: Boolean(opts.apply), force: Boolean(opts.force), source: 'teleport', detail: fetched.detail });
    });
}

function runApplyOrPrint(
  ctx: AppContext,
  proposals: DiscoveryProposal[],
  opts: { apply: boolean; force: boolean; source: string; detail: string },
): void {
  if (!opts.apply) {
    if (ctx.jsonMode) {
      printJson({ ok: true, source: opts.source, detail: opts.detail, applied: false, proposals });
    } else {
      console.log(`Source: ${opts.source} (${opts.detail})`);
      console.log(renderProposals(proposals));
      if (proposals.length) {
        console.log('\nDry-run. Re-run with --apply to save these profiles. Add `--force` to overwrite existing names.');
        console.log('Credentials are NOT saved by discover. After applying, run:');
        for (const p of proposals.slice(0, 5)) {
          console.log(`  taproot creds set --ref ${p.credentialRef} --user <user> --password '<***>'`);
        }
        if (proposals.length > 5) console.log(`  ... (${proposals.length - 5} more)`);
      }
    }
    return;
  }
  const result = applyProposals(ctx, proposals, { force: opts.force });
  if (ctx.jsonMode) {
    printJson({
      ok: true,
      source: opts.source,
      detail: opts.detail,
      applied: true,
      saved: result.saved.map((s) => s.name),
      conflicts: result.conflicts.map((c) => ({ name: c.name, reason: 'already exists; re-run with --force to overwrite' })),
      skipped: result.skipped,
    });
    return;
  }
  console.log(`Source: ${opts.source} (${opts.detail})`);
  console.log(`Saved: ${result.saved.length}`);
  for (const s of result.saved) console.log(`  + ${s.name}`);
  if (result.conflicts.length) {
    console.log(`Conflicts (skipped): ${result.conflicts.length}. Re-run with --force to overwrite.`);
    for (const c of result.conflicts) console.log(`  ! ${c.name}`);
  }
  if (result.saved.length) {
    console.log('\nNext: set credentials per datasource:');
    for (const s of result.saved.slice(0, 5)) {
      console.log(`  taproot creds set --ref ${s.credentialRef} --user <user> --password '<***>'`);
    }
  }
}
