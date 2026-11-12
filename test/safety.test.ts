import { describe, expect, it } from 'vitest';
import { classifySql, enforceMutationPolicy } from '../src/core/safety.js';

describe('safety', () => {
  it('classifies mutate vs read', () => {
    expect(classifySql('SELECT 1')).toBe('read');
    expect(classifySql('SHOW CREATE TABLE sample_table')).toBe('read');
    expect(classifySql('UPDATE x SET a=1')).toBe('mutate');
  });

  it.each([
    'WITH recent AS (SELECT id FROM sample_table) SELECT * FROM recent',
    '(SELECT 1) UNION (SELECT 2)',
    'SELECT * FROM sample_table PARTITION (p1)',
    "SHOW VARIABLES LIKE 'max_connections'",
    'SHOW FULL COLUMNS FROM sample_table',
    'DESC sample_table',
    'EXPLAIN FORMAT=JSON DELETE FROM sample_table',
    'EXPLAIN ANALYZE SELECT * FROM sample_table',
    "EXPLAIN ANALYZE FORMAT = 'brief' SELECT * FROM sample_table",
  ])('allows the read statement %s', (sql) => {
    expect(classifySql(sql)).toBe('read');
  });

  it.each([
    'EXPLAIN ANALYZE DELETE FROM sample_table WHERE id = 1',
    'DESC ANALYZE UPDATE sample_table SET a = 1',
    'WITH stale AS (SELECT id FROM sample_table) DELETE FROM sample_table WHERE id IN (SELECT id FROM stale)',
    'CALL refresh_totals()',
    'KILL 1',
    'SET GLOBAL max_connections = 1',
    "LOAD DATA INFILE 'rows.csv' INTO TABLE sample_table",
    "SELECT * FROM sample_table INTO OUTFILE '/tmp/rows'",
    'SELECT 1; DELETE FROM sample_table',
    'DO 1',
  ])('treats %s as mutate', (sql) => {
    expect(classifySql(sql)).toBe('mutate');
  });

  it.each([
    'USE other_db',
    "SET time_zone = '+05:30'",
    'SET SESSION transaction_read_only = 0',
    'SELECT @last := id FROM sample_table',
    "SELECT GET_LOCK('job', 10)",
  ])('treats the session-state change %s as mutate', (sql) => {
    expect(classifySql(sql)).toBe('mutate');
  });

  it.each([
    '-- daily check\nSELECT * FROM sample_table',
    '# daily check\nSELECT 1',
    '/* agent */ SELECT 1',
    'SELECT 1 -- into the report',
    "SELECT * FROM sample_table WHERE note = 'moved into archive'",
    "SELECT * FROM sample_table WHERE note = 'a := b; DELETE'",
    'SELECT `into` FROM sample_table',
    "SELECT * FROM sample_table WHERE note = 'it''s into'",
  ])('reads past comments and quoted text in %s', (sql) => {
    expect(classifySql(sql)).toBe('read');
  });

  it.each([
    '/*!50000 DELETE FROM sample_table */',
    '-- note\nDELETE FROM sample_table',
    '/* note */ EXPLAIN ANALYZE DELETE FROM sample_table',
    "SELECT 'a' INTO @copy",
  ])('still treats %s as mutate', (sql) => {
    expect(classifySql(sql)).toBe('mutate');
  });

  it('leaves non-SQL commands to their plugin', () => {
    expect(() =>
      enforceMutationPolicy({
        sql: 'GET profile:1',
        allowMutate: false,
        datasource: {
          name: 'd',
          kind: 'redis',
          connection: {},
          credentialRef: 'r',
          policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
          updatedAt: '',
          confidence: 1,
        },
      }),
    ).not.toThrow();
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

  it.each([
    ['SELECT 1; SELECT 2', false],
    ['-- check\nSHOW TABLES; SHOW DATABASES', false],
    ['SELECT 1; DELETE FROM x', true],
  ])('asks for one statement per query instead of --allow-mutate for %s', (sql, allowMutate) => {
    expect(() =>
      enforceMutationPolicy({
        sql,
        allowMutate,
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
    ).toThrow(/^BAD_INPUT: send one SQL statement per query/);
  });

  it('asks for --allow-mutate on several writes in one query', () => {
    expect(() =>
      enforceMutationPolicy({
        sql: 'DELETE FROM a; DELETE FROM b',
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

  it('lets a stored procedure body with semicolons through with --allow-mutate', () => {
    expect(() =>
      enforceMutationPolicy({
        sql: 'CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END',
        allowMutate: true,
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
