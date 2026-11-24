import type { DatasourcePolicy } from '../types/datasource.js';

export function readOnlyPolicy(): DatasourcePolicy {
  return { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] };
}
