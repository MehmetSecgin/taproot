import type { AppContext } from '../core/app.js';
import { runDatasourceConnectors } from '../core/connector-runner.js';
import { classifyError } from '../core/error-classification.js';
import { exitCodeForClass } from '../core/exit-codes.js';
import { printSuccess } from '../core/output.js';
import type { DatasourceProfile } from '../types/datasource.js';
import { DoctorStatus } from '../types/plugin.js';
import type { DoctorCheck } from '../types/plugin.js';
import type { DoctorCapablePlugin } from './doctor-plugin.js';

export type DoctorTarget = { datasource: DatasourceProfile; plugin: DoctorCapablePlugin };

export function summarizeChecks(checks: DoctorCheck[]): { ok: number; warn: number; fail: number; total: number } {
  const countWithStatus = (status: DoctorStatus): number => checks.filter((check) => check.status === status).length;
  return {
    ok: countWithStatus(DoctorStatus.Ok),
    warn: countWithStatus(DoctorStatus.Warn),
    fail: countWithStatus(DoctorStatus.Fail),
    total: checks.length,
  };
}

export async function runDoctorChecks(ctx: AppContext, target: DoctorTarget, connect: boolean): Promise<DoctorCheck[]> {
  const { datasource, plugin } = target;
  const credentials = await ctx.credentialStore.get(datasource.credentialRef);
  const connectorInput = { datasource, credentialStore: ctx.credentialStore, pluginRegistry: ctx.pluginRegistry };
  const checks = connect ? await runDatasourceConnectors({ ...connectorInput, mode: 'connect' }) : [];
  checks.push(
    ...(await runDatasourceConnectors({ ...connectorInput, mode: 'doctor' })),
    ...(await plugin.doctor({ datasource, credentials })),
  );
  return checks;
}

export function reportDoctorChecks(target: DoctorTarget, warnings: string[], checks: DoctorCheck[]): void {
  printSuccess({
    datasource: target.datasource.name,
    plugin: target.plugin.manifest.name,
    ...(warnings.length > 0 ? { warnings } : {}),
    checks,
    summary: summarizeChecks(checks),
  });
  const firstFailure = checks.find((check) => check.status === DoctorStatus.Fail);
  if (firstFailure) {
    process.exitCode = exitCodeForClass(classifyError(firstFailure.detail));
  }
}
