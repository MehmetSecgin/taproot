import { environmentPolicy } from './app.js';
import type { AppContext } from './app.js';
import { DoctorStatus } from '../types/core.js';
import type { DatasourceProfile, DoctorCheck } from '../types/core.js';

export function deniedKindCheck(ctx: Pick<AppContext, 'runtimeConfigStore'>, datasource: DatasourceProfile): DoctorCheck | undefined {
  if (!environmentPolicy(ctx, datasource.env).denyKinds.includes(datasource.kind)) return undefined;
  return {
    check: 'environment policy',
    status: DoctorStatus.Fail,
    detail: `kind '${datasource.kind}' is denied in environment '${datasource.env}' by environmentPolicies.denyKinds; nothing was contacted`,
  };
}
