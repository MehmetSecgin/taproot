import { describe, expect, it } from 'vitest';
import { classifyError, classifyExecutorDoctorCode, spawnErrorMessage } from '../src/core/error-classification.js';
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
  });

  it('splits SQL errors into actionable codes', () => {
    expect(classifyError("Unknown column 'author_id' in 'field list'")).toBe('UNKNOWN_COLUMN');
    expect(classifyError('column "author_id" does not exist')).toBe('UNKNOWN_COLUMN');
    expect(classifyError("Table 'shop.orders' doesn't exist")).toBe('UNKNOWN_TABLE');
    expect(classifyError('relation "orders" does not exist')).toBe('UNKNOWN_TABLE');
    expect(classifyError("You have an error in your SQL syntax; check the manual near 'SELEC'")).toBe('SQL_SYNTAX');
    expect(classifyError('syntax error at or near "SELEC"')).toBe('SQL_SYNTAX');
    expect(exitCodeForClass('SQL_SYNTAX')).toBe(EXIT_CODES.BAD_INPUT);
  });

  it('maps an ambiguous column reference to AMBIGUOUS_COLUMN', () => {
    expect(classifyError("Column 'created_at' in field list is ambiguous")).toBe('AMBIGUOUS_COLUMN');
    expect(classifyError('column reference "created_at" is ambiguous')).toBe('AMBIGUOUS_COLUMN');
    expect(exitCodeForClass('AMBIGUOUS_COLUMN')).toBe(EXIT_CODES.BAD_INPUT);
  });

  it('maps several allowed Teleport db users to AMBIGUOUS_DB_USER', () => {
    expect(classifyError("teleport-mysql found several allowed db users for 'db-a' in 'tsh db ls': reader, writer.")).toBe('AMBIGUOUS_DB_USER');
    expect(exitCodeForClass('AMBIGUOUS_DB_USER')).toBe(EXIT_CODES.BAD_INPUT);
  });

  it('maps unknown datasource names to UNKNOWN_DATASOURCE', () => {
    expect(classifyError("Datasource resolution failed: no profile for datasource 'qa-shop-develp'. Did you mean qa-shop-develop?")).toBe('UNKNOWN_DATASOURCE');
    expect(exitCodeForClass('UNKNOWN_DATASOURCE')).toBe(EXIT_CODES.BAD_INPUT);
  });

  it('maps a resource group quota rejection to RESOURCE_LIMIT', () => {
    expect(classifyError('Exceeded resource group quota limitation')).toBe('RESOURCE_LIMIT');
    expect(exitCodeForClass('RESOURCE_LIMIT')).toBe(EXIT_CODES.GENERAL_ERROR);
  });

  it('maps a statement the server stopped at max_execution_time to QUERY_TIMEOUT', () => {
    expect(classifyError('Query execution was interrupted, maximum statement execution time exceeded')).toBe('QUERY_TIMEOUT');
    expect(classifyError('[executor:3024]Query execution was interrupted, maximum statement execution time exceeded')).toBe('QUERY_TIMEOUT');
    expect(classifyError('Query execution was interrupted')).toBe('QUERY_TIMEOUT');
  });

  it('maps a runaway query kill to RESOURCE_LIMIT', () => {
    expect(classifyError('Query execution was interrupted, identified as runaway query [ElapsedTime = 10s(5s)]')).toBe('RESOURCE_LIMIT');
  });

  it('maps a runaway watch list interruption to RESOURCE_LIMIT', () => {
    expect(classifyError('Quarantined and interrupted because of being in runaway watch list')).toBe('RESOURCE_LIMIT');
  });

  it('keeps the class named by a code prefix', () => {
    expect(classifyError('CONNECTIVITY: short-circuited without connecting')).toBe('CONNECTIVITY');
    expect(classifyError('ACCESS_DENIED: credential missing')).toBe('ACCESS_DENIED');
  });

  it('maps expired sessions and rejected credentials to AUTH_EXPIRED', () => {
    expect(classifyError('ERROR: not logged in')).toBe('AUTH_EXPIRED');
    expect(classifyError('ERROR: Your session has expired. Please login again.')).toBe('AUTH_EXPIRED');
    expect(classifyError('x509: certificate has expired or is not yet valid')).toBe('AUTH_EXPIRED');
    expect(classifyError('error: You must be logged in to the server (Unauthorized)')).toBe('AUTH_EXPIRED');
    expect(classifyError('grpc_code=16 UNAUTHENTICATED: token rejected')).toBe('AUTH_EXPIRED');
    expect(classifyError('NOAUTH Authentication required.')).toBe('AUTH_EXPIRED');
    expect(exitCodeForClass('AUTH_EXPIRED')).toBe(EXIT_CODES.AUTH);
  });

  it('does not read auth or login inside a name as an auth failure', () => {
    expect(classifyError('Datasource not found: auth-service')).toBe('GENERIC');
    expect(classifyError('Datasource not found: login-history')).toBe('GENERIC');
    expect(classifyError('Datasource not found: expired-orders')).toBe('GENERIC');
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

  it('maps a missing binary to MISSING_TOOL with the not-ready exit code', () => {
    const message = spawnErrorMessage(new Error('spawn tsh ENOENT'));
    expect(message).toBe('MISSING_TOOL: tsh is not installed or not on PATH; install it, then retry.');
    expect(classifyError(message)).toBe('MISSING_TOOL');
    expect(classifyError('/bin/sh: kubectl: command not found')).toBe('MISSING_TOOL');
    expect(exitCodeForClass('MISSING_TOOL')).toBe(EXIT_CODES.NOT_READY);
    expect(classifyExecutorDoctorCode(message)).toBe('executor_missing_tool');
  });
});
