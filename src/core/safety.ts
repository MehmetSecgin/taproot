import type { DatasourceProfile } from '../types/core.js';

const MUTATE_RE = /\b(insert|update|delete|alter|drop|truncate|create|replace|grant|revoke|rename)\b/i;

export function classifyMutation(sql: string): 'read' | 'mutate' {
  return MUTATE_RE.test(sql) ? 'mutate' : 'read';
}

export function enforceMutationPolicy(input: {
  sql: string;
  allowMutate: boolean;
  datasource: DatasourceProfile;
}): void {
  const mode = classifyMutation(input.sql);
  if (mode === 'read') {
    if (!input.datasource.policy.allowRead) {
      throw new Error('Datasource policy disallows read queries.');
    }
    return;
  }
  if (!input.allowMutate) {
    throw new Error('Mutating query detected. Re-run with --allow-mutate.');
  }
  if (!input.datasource.policy.allowMutate) {
    throw new Error('Datasource policy disallows mutate queries.');
  }
  if (!input.datasource.policy.allowedCapabilities.includes('executeMutate')) {
    throw new Error('Datasource capability policy disallows executeMutate.');
  }
}
