import fs from 'node:fs';
import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { defaultDatasourceName, normalizeNamespace, normalizeService } from '../core/app.js';
import { reconcileDatasource } from '../core/bootstrap.js';
import { printJson } from '../core/output.js';
import { collectReadinessSnapshot } from '../core/readiness.js';
import { ensureStarterRuntime } from '../core/runtime-init.js';

function printHumanInit(checks: Array<{ check: string; status: string; detail: string }>, readiness: string, nextActions: string[]): void {
  checks.forEach((check) => console.log(`${check.status.toUpperCase()} ${check.check}: ${check.detail}`));
  console.log(`readiness: ${readiness}`);
  if (nextActions.length) {
    console.log('next actions:');
    for (const action of nextActions) console.log(`- ${action}`);
  }
}

export function registerInit(program: Command, getCtx: () => AppContext): void {
  const init = program.command('init').description('Initialize local TapRoot runtime state for first use');

  init.action(async () => {
    const ctx = getCtx();
    const createdConfig = ensureStarterRuntime(ctx);
    const snapshot = await collectReadinessSnapshot(ctx, { createdConfig });
    const data = {
      checks: snapshot.checks,
      readiness: snapshot.readiness,
      nextActions: snapshot.nextActions,
      nextActionDetails: snapshot.nextActionDetails,
    };
    if (ctx.jsonMode) printJson(data);
    else printHumanInit(snapshot.checks, snapshot.readiness, snapshot.nextActions);
  });

  init.command('datasource')
    .description('Create a datasource profile from KB-backed connection metadata')
    .requiredOption('--env <env>')
    .option('--namespace <namespace>')
    .requiredOption('--service <service>')
    .action(async (opts) => {
      const ctx = getCtx();
      const service = normalizeService(opts.service, ctx.runtimeConfigStore.serviceAliases());
      const namespace = normalizeNamespace(opts.namespace);
      const datasourceName = defaultDatasourceName(opts.env, service, namespace || undefined);
      const result = await reconcileDatasource(ctx, opts.env, service, datasourceName, namespace || undefined);
      if (!result) {
        throw new Error(`No KB data found for env=${opts.env}${namespace ? ` namespace=${namespace}` : ''} service=${service}`);
      }
      const data = {
        source: result.source,
        skipped: result.source === 'store-existing',
        profile: result.profile,
        credentialRefs: result.credentialRefs,
        connectors: result.connectors,
        warnings: result.warnings,
      };
      if (ctx.jsonMode) {
        printJson(data);
        return;
      }
      console.log(
        result.source === 'store-existing'
          ? `Datasource already exists: ${result.profile.name}`
          : result.source === 'kb-repaired'
            ? `Repaired datasource: ${result.profile.name}`
            : `Created datasource: ${result.profile.name}`,
      );
      console.log(`source: ${result.source}`);
      console.log(`credentialRefs: ${result.credentialRefs.join(', ') || '(none)'}`);
      console.log(`connectors: ${result.connectors.join(', ') || '(none)'}`);
      if (result.warnings.length) {
        console.log('warnings:');
        for (const warning of result.warnings) console.log(`- ${warning}`);
      }
    });
}
