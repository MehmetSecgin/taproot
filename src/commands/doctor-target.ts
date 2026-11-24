import type { VerboseLog } from '../cli/verbose-log.js';
import type { AppContext } from '../core/app.js';
import { EXIT_CODES } from '../core/exit-codes.js';
import { normalizeNamespace, normalizeService } from '../core/naming.js';
import { printSuccess } from '../core/output.js';
import type { DatasourceProfile } from '../types/datasource.js';
import { DoctorStatus } from '../types/plugin.js';
import type { DoctorCheck } from '../types/plugin.js';
import { describeTarget } from '../core/describe-target.js';
import { summarizeChecks } from './doctor-checks.js';
import { emptyToUndefined } from '../core/text-presence.js';

export type DoctorOptions = { datasource?: string; env?: string; namespace?: string; service?: string; connect: boolean };

type UnresolvedTarget = {
  env: string;
  service: string;
  namespace?: string;
  kbHasConnection: boolean;
};

type DoctorResolution = { datasource: DatasourceProfile } | { unresolved: UnresolvedTarget };

function unresolvedTargetChecks(target: UnresolvedTarget): DoctorCheck[] {
  const label = describeTarget(target);
  return [
    {
      check: 'target_datasource',
      status: DoctorStatus.Fail,
      detail: `No datasource profile for ${label}; doctor reports state and does not create one`,
    },
    {
      check: 'kb routing',
      status: target.kbHasConnection ? DoctorStatus.Ok : DoctorStatus.Warn,
      detail: target.kbHasConnection
        ? `KB has a connection for ${label}, so the profile can be created from it`
        : `KB has no connection for ${label}, so the profile has to be described by hand`,
    },
    {
      check: 'doctor blocked',
      status: DoctorStatus.Warn,
      detail: 'plugin/connectivity checks skipped until the datasource profile exists',
    },
  ];
}

function findNamedDatasource(ctx: AppContext, rawName: string | undefined): DatasourceProfile | undefined {
  const name = emptyToUndefined(rawName);
  return name === undefined ? undefined : ctx.datasourceStore.get(name);
}

function resolveByEnvAndService(ctx: AppContext, request: { env: string; service: string; namespace?: string }): DoctorResolution {
  const service = normalizeService(request.service, ctx.runtimeConfigStore.serviceAliases());
  const namespace = emptyToUndefined(normalizeNamespace(request.namespace));
  const found = ctx.datasourceStore.resolveByEnvService({ env: request.env, namespace, service, preferKinds: [] });
  if (found) {
    return { datasource: found };
  }
  const kbHasConnection = Boolean(ctx.kbStore.resolveConnection(service, request.env, namespace));
  return { unresolved: { env: request.env, service, namespace, kbHasConnection } };
}

export function resolveDoctorDatasource(ctx: AppContext, opts: DoctorOptions): DoctorResolution {
  const named = findNamedDatasource(ctx, opts.datasource);
  if (named) {
    return { datasource: named };
  }
  const env = emptyToUndefined(opts.env);
  const service = emptyToUndefined(opts.service);
  if (env === undefined || service === undefined) {
    throw new Error('Could not resolve datasource. Use --datasource or --env+--service.');
  }
  return resolveByEnvAndService(ctx, { env, service, namespace: opts.namespace });
}

export function reportUnresolvedTarget(target: UnresolvedTarget, logVerbose: VerboseLog): void {
  logVerbose(`no datasource profile for ${describeTarget(target)}`);
  const checks = unresolvedTargetChecks(target);
  printSuccess({ checks, summary: summarizeChecks(checks) });
  process.exitCode = EXIT_CODES.NOT_READY;
}
