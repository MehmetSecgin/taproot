import { describe, expect, it } from 'vitest';
import { classifyMutation, enforceMutationPolicy, enforceSchemaIntrospectionPolicy, isRedundantIntrospectionQuery } from '../src/core/safety.js';

describe('safety', () => {
  it('classifies mutate vs read', () => {
    expect(classifyMutation('SELECT 1')).toBe('read');
    expect(classifyMutation('SHOW CREATE TABLE sample_table')).toBe('read');
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

  it('detects redundant introspection patterns', () => {
    expect(isRedundantIntrospectionQuery('SHOW CREATE TABLE event')).toBe(true);
    expect(isRedundantIntrospectionQuery('show full columns from event')).toBe(true);
    expect(isRedundantIntrospectionQuery('DESCRIBE event')).toBe(true);
    expect(isRedundantIntrospectionQuery('DESC event')).toBe(true);
    expect(isRedundantIntrospectionQuery('SHOW INDEXES FROM event')).toBe(true);
    expect(isRedundantIntrospectionQuery('SELECT * FROM event LIMIT 1')).toBe(false);
    expect(isRedundantIntrospectionQuery('SELECT TABLE_NAME FROM information_schema.tables')).toBe(false);
  });

  it('blocks SHOW CREATE when service schema is already cached', () => {
    expect(() =>
      enforceSchemaIntrospectionPolicy({
        sql: 'SHOW CREATE TABLE event',
        service: 'orders',
        hasRefreshedSchema: true,
      }),
    ).toThrow(/REDUNDANT_INTROSPECTION/);
  });

  it('does not block when schema has never been refreshed', () => {
    expect(() =>
      enforceSchemaIntrospectionPolicy({
        sql: 'SHOW CREATE TABLE event',
        service: 'orders',
        hasRefreshedSchema: false,
      }),
    ).not.toThrow();
  });

  it('bypasses redundant-introspection gate with allowSchemaIntrospection', () => {
    const warnings = enforceSchemaIntrospectionPolicy({
      sql: 'SHOW CREATE TABLE event',
      service: 'orders',
      hasRefreshedSchema: true,
      allowSchemaIntrospection: true,
    });
    expect(warnings).toContain('schema_introspection_bypassed');
  });

  it('does not block regular SELECT queries', () => {
    expect(() =>
      enforceSchemaIntrospectionPolicy({
        sql: 'SELECT id FROM event LIMIT 1',
        service: 'orders',
        hasRefreshedSchema: true,
      }),
    ).not.toThrow();
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
