import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { printJson } from '../core/output.js';
import {
  applyKbProposals,
  applyProposals,
  buildKbProposals,
  classifyKubeService,
  classifyTshDatabase,
  fetchKubeServices,
  fetchTshDatabases,
  type DiscoveryProposal,
} from '../core/discover-datasources.js';

export function registerDiscover(program: Command, getCtx: () => AppContext): void {
  const discover = program
    .command('discover')
    .description('Discover candidate datasources from local tooling (kubectl, tsh, KB)');

  discover
    .command('kb')
    .description('Generate datasource proposals from the local KB (services.json) for an env')
    .requiredOption('--env <env>', 'Environment to materialize datasources for')
    .option('--namespace <namespace>', 'Limit to a single namespace (matches KB connection.namespace)')
    .option('--service <service>', 'Limit to a single KB service entry')
    .option('--apply', 'Save proposals into the datasource store and seed connector credential defaults', false)
    .option('--force', 'Overwrite existing datasource profiles with the same name', false)
    .action(async (opts) => {
      const ctx = getCtx();
      const kbOpts = { env: opts.env, namespace: opts.namespace, service: opts.service };
      if (!opts.apply) {
        const { proposals, skipped } = buildKbProposals(ctx, kbOpts);
        printJson({ ok: true, source: 'kb', applied: false, proposals, skipped });
        return;
      }
      const result = await applyKbProposals(ctx, { ...kbOpts, force: Boolean(opts.force) });
      printJson({
        ok: true,
        source: 'kb',
        applied: true,
        saved: result.saved.map((s) => s.name),
        conflicts: result.conflicts.map((c) => ({ name: c.name, reason: 'already exists; re-run with --force' })),
        skipped: result.skipped,
        credentialDefaultsApplied: result.credentialDefaultsApplied,
      });
    });

  discover
    .command('kubectl')
    .description('Scan kubectl-visible services for DB-shaped candidates')
    .requiredOption('--env <env>', 'Environment tag to assign to discovered datasources')
    .option('--namespace <namespace>', 'Limit scan to a single namespace (default: all namespaces)')
    .option('--context <context>', 'kubectl context (defaults to current)')
    .option('--host-pattern <pattern>', 'service-name (default) | tiproxy (build tiproxy-<svc>.<ns> hosts)', 'service-name')
    .option('--shared-credential-ref', 'Use a single env-wide credential ref (e.g. `qa`) instead of `env:service`', false)
    .option('--no-vpn', 'Do not wire the `openvpn` connector (default: wired)')
    .option('--apply', 'Save proposals into the local datasource store', false)
    .option('--force', 'Overwrite existing datasource profiles with the same name', false)
    .action((opts) => {
      const ctx = getCtx();
      const fetched = fetchKubeServices({ namespace: opts.namespace, context: opts.context });
      if (!fetched.ok) {
        printJson({ ok: false, source: 'kubectl', error: fetched.detail });
        process.exitCode = 1;
        return;
      }
      const aliases = ctx.runtimeConfigStore.serviceAliases();
      const hostPattern = opts.hostPattern === 'tiproxy' ? 'tiproxy' : 'service-name';
      const proposals = fetched.services
        .map((svc) => classifyKubeService(svc, {
          env: opts.env,
          aliases,
          vpn: opts.vpn !== false,
          hostPattern,
          sharedCredentialRef: Boolean(opts.sharedCredentialRef),
        }))
        .filter((p): p is DiscoveryProposal => Boolean(p));
      runApplyOrPrint(ctx, proposals, { apply: Boolean(opts.apply), force: Boolean(opts.force), source: 'kubectl', detail: fetched.detail });
    });

  discover
    .command('teleport')
    .description('Scan `tsh db ls` for DB datasources')
    .requiredOption('--env <env>')
    .option('--no-vpn', 'Do not wire the `openvpn` connector (default: wired alongside teleport)')
    .option('--apply', 'Save proposals into the local datasource store', false)
    .option('--force', 'Overwrite existing datasource profiles with the same name', false)
    .action((opts) => {
      const ctx = getCtx();
      const fetched = fetchTshDatabases();
      if (!fetched.ok) {
        printJson({ ok: false, source: 'teleport', error: fetched.detail });
        process.exitCode = 1;
        return;
      }
      const aliases = ctx.runtimeConfigStore.serviceAliases();
      const proposals = fetched.databases
        .map((db) => classifyTshDatabase(db, { env: opts.env, aliases, vpn: opts.vpn !== false }))
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
    printJson({ ok: true, source: opts.source, detail: opts.detail, applied: false, proposals });
    return;
  }
  const result = applyProposals(ctx, proposals, { force: opts.force });
  printJson({
    ok: true,
    source: opts.source,
    detail: opts.detail,
    applied: true,
    saved: result.saved.map((s) => s.name),
    conflicts: result.conflicts.map((c) => ({ name: c.name, reason: 'already exists; re-run with --force to overwrite' })),
    skipped: result.skipped,
  });
}
