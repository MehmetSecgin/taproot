import { describe, expect, it } from 'vitest';
import { classifyMutation, enforceMutationPolicy } from '../src/core/safety.js';

describe('safety', () => {
  it('classifies mutate vs read', () => {
    expect(classifyMutation('SELECT 1')).toBe('read');
    expect(classifyMutation('UPDATE x SET a=1')).toBe('mutate');
  });

  it('blocks mutate without allow flag', () => {
    expect(() =>
      enforceMutationPolicy({
        sql: 'DELETE FROM x',
        allowMutate: false,
        datasource: {
          name: 'd',
          kind: 'mysql',
          connection: {},
          credentialRef: 'r',
          policy: { allowRead: true, allowMutate: true, allowedCapabilities: ['executeRead', 'executeMutate'] },
          updatedAt: '',
          confidence: 1,
        },
      }),
    ).toThrow(/allow-mutate/);
  });

  it('blocks mutate when datasource policy disallows', () => {
    expect(() =>
      enforceMutationPolicy({
        sql: 'UPDATE x SET a=1',
        allowMutate: true,
        datasource: {
          name: 'd',
          kind: 'mysql',
          connection: {},
          credentialRef: 'r',
          policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
          updatedAt: '',
          confidence: 1,
        },
      }),
    ).toThrow(/policy disallows mutate/);
  });
});
