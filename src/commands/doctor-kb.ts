import type { AppContext } from '../core/app.js';
import { blockingDatasourceKbConflicts, datasourceKbConflicts } from '../core/conflicts.js';
import { exitCodeForClass } from '../core/exit-codes.js';
import { printSuccess } from '../core/output.js';
import type { DatasourceProfile } from '../types/datasource.js';
import { DoctorStatus } from '../types/plugin.js';
import type { DoctorCheck } from '../types/plugin.js';
import { summarizeChecks } from './doctor-checks.js';
import type { DoctorTarget } from './doctor-checks.js';

export type KbComparison = { blockingConflicts: string[]; warnings: string[] };

function kbConnectionFor(ctx: AppContext, datasource: DatasourceProfile): Record<string, unknown> | null {
  if ((datasource.env ?? '') === '' || (datasource.service ?? '') === '') {
    return null;
  }
  return ctx.kbStore.resolveConnection(datasource.service ?? '', datasource.env ?? '', datasource.namespace);
}

export function compareWithKb(ctx: AppContext, datasource: DatasourceProfile): KbComparison {
  const kbConnection = kbConnectionFor(ctx, datasource);
  if (!kbConnection) {
    return { blockingConflicts: [], warnings: [] };
  }
  const blockingConflicts = blockingDatasourceKbConflicts(datasource, kbConnection);
  if (blockingConflicts.length > 0) {
    return { blockingConflicts, warnings: [] };
  }
  const conflicts = datasourceKbConflicts(datasource, kbConnection);
  return { blockingConflicts, warnings: conflicts.length > 0 ? [`datasource overrides KB (${conflicts.join('; ')})`] : [] };
}

export function reportKbRoutingBlocked(target: DoctorTarget, blockingConflicts: string[]): void {
  const checks: DoctorCheck[] = [
    {
      check: 'kb routing consistency',
      status: DoctorStatus.Fail,
      detail: `MISCONFIGURED_DATASOURCE: ${blockingConflicts.join('; ')}`,
    },
    {
      check: 'doctor blocked',
      status: DoctorStatus.Warn,
      detail: 'plugin/connectivity checks skipped until datasource routing matches KB',
    },
  ];
  printSuccess({
    datasource: target.datasource.name,
    plugin: target.plugin.manifest.name,
    checks,
    summary: summarizeChecks(checks),
  });
  process.exitCode = exitCodeForClass('MISCONFIGURED_DATASOURCE');
}
