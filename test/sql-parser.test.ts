import { describe, expect, it } from 'vitest';
import { parseExecutedStatements } from '../src/core/sql-parser.js';

describe('parseExecutedStatements', () => {
  it('parses a repeated query once and hands back a frozen tree', () => {
    // arrange
    const sql = 'SELECT id FROM orders WHERE created_at > NOW()';
    const first = parseExecutedStatements(sql);

    // act
    const second = parseExecutedStatements(sql);

    // assert
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.[0])).toBe(true);
  });

  it('shares the parse between an EXPLAIN ANALYZE query and its target', () => {
    // arrange
    const target = 'SELECT id FROM orders';
    const explained = parseExecutedStatements(`EXPLAIN ANALYZE ${target}`);

    // act
    const direct = parseExecutedStatements(target);

    // assert
    expect(direct).toBe(explained);
  });
});
