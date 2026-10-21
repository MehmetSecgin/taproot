import { describe, expect, it } from 'vitest';
import { classifyError, nextAction } from '../src/core/app.js';
import { classifyExecutorDoctorCode } from '../src/core/error-classification.js';
import { EXIT_CODES, exitCodeForClass } from '../src/core/exit-codes.js';

describe('error classification', () => {
  it('maps ECONNREFUSED to CONNECTIVITY', () => {
    expect(classifyError('connect ECONNREFUSED 127.0.0.1:4406')).toBe('CONNECTIVITY');
    expect(exitCodeForClass('CONNECTIVITY')).toBe(EXIT_CODES.CONNECTIVITY);
  });

  it('maps cluster DNS failures to CONNECTIVITY and public hosts to UNKNOWN_TARGET', () => {
    expect(classifyError('getaddrinfo ENOTFOUND example-svc.test-ns')).toBe('CONNECTIVITY');
    expect(classifyError('getaddrinfo ENOTFOUND qa-svc-grpc.test-ns.svc.cluster.local')).toBe('CONNECTIVITY');
    expect(classifyError('getaddrinfo EAI_AGAIN db.example.com')).toBe('CONNECTIVITY');
    expect(classifyError('getaddrinfo ENOTFOUND db.eu.example.com')).toBe('UNKNOWN_TARGET');
    expect(nextAction('CONNECTIVITY')).toContain('cluster DNS');
  });

  it('splits SQL errors into actionable codes', () => {
    expect(classifyError("Unknown column 'author_id' in 'field list'")).toBe('UNKNOWN_COLUMN');
    expect(classifyError('column "author_id" does not exist')).toBe('UNKNOWN_COLUMN');
    expect(classifyError("Table 'shop.orders' doesn't exist")).toBe('UNKNOWN_TABLE');
    expect(classifyError('relation "orders" does not exist')).toBe('UNKNOWN_TABLE');
    expect(classifyError("You have an error in your SQL syntax; check the manual near 'SELEC'")).toBe('SQL_SYNTAX');
    expect(classifyError('syntax error at or near "SELEC"')).toBe('SQL_SYNTAX');
    expect(nextAction('UNKNOWN_COLUMN')).toContain('meta.schemaContext');
    expect(exitCodeForClass('SQL_SYNTAX')).toBe(EXIT_CODES.BAD_INPUT);
  });

  it('maps several allowed Teleport db users to AMBIGUOUS_DB_USER', () => {
    expect(classifyError("teleport-mysql found several allowed db users for 'db-a' in 'tsh db ls': reader, writer.")).toBe('AMBIGUOUS_DB_USER');
    expect(exitCodeForClass('AMBIGUOUS_DB_USER')).toBe(EXIT_CODES.BAD_INPUT);
  });

  it('maps unknown datasource names to UNKNOWN_DATASOURCE', () => {
    expect(classifyError("Datasource resolution failed: no profile for datasource 'qa-shop-develp'. Did you mean qa-shop-develop?")).toBe('UNKNOWN_DATASOURCE');
    expect(exitCodeForClass('UNKNOWN_DATASOURCE')).toBe(EXIT_CODES.BAD_INPUT);
  });

  it('points schema errors at a cached-schema command that works without --json', () => {
    expect(nextAction('UNKNOWN_COLUMN')).not.toContain('this envelope');
    expect(nextAction('UNKNOWN_COLUMN')).toContain('learn ensure-schema --datasource');
    expect(nextAction('UNKNOWN_TABLE')).toContain('learn tables --datasource');
  });

  it('keeps the class named by a code prefix', () => {
    expect(classifyError('CONNECTIVITY: short-circuited without connecting')).toBe('CONNECTIVITY');
    expect(classifyError('ACCESS_DENIED: credential missing')).toBe('ACCESS_DENIED');
  });

  it('maps permission errors to ACCESS_DENIED', () => {
    expect(classifyError('Access denied for user')).toBe('ACCESS_DENIED');
    expect(exitCodeForClass('ACCESS_DENIED')).toBe(EXIT_CODES.ACCESS_DENIED);
  });

  it('maps missing partition predicates to bad input', () => {
    expect(classifyError('MISSING_PARTITION_PREDICATE: order_items is partitioned')).toBe('MISSING_PARTITION_PREDICATE');
    expect(exitCodeForClass('MISSING_PARTITION_PREDICATE')).toBe(EXIT_CODES.BAD_INPUT);
  });

  it('maps executor doctor failures to machine-readable codes', () => {
    expect(classifyExecutorDoctorCode('connect ECONNREFUSED 127.0.0.1:4406')).toBe('executor_connectivity');
    expect(classifyExecutorDoctorCode('Access denied for user')).toBe('executor_access_denied');
    expect(classifyExecutorDoctorCode('missing target/dbUser/database in datasource+credentials')).toBe(
      'executor_configuration_missing',
    );
  });
});
