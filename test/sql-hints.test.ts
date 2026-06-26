import { describe, expect, it } from 'vitest';
import { enrichSqlSyntaxError, reservedAliasHint } from '../src/core/sql-hints.js';

describe('reservedAliasHint', () => {
  it('flags a bare reserved word used as an alias', () => {
    const hint = reservedAliasHint('SELECT COUNT(*) rows FROM t');
    expect(hint).toContain('rows');
    expect(hint).toContain('`rows`');
  });

  it('flags an AS-qualified reserved alias', () => {
    expect(reservedAliasHint('SELECT COUNT(*) AS rank FROM t')).toContain('rank');
  });

  it('ignores reserved words already quoted with backticks', () => {
    expect(reservedAliasHint('SELECT COUNT(*) `rows` FROM t')).toBeNull();
  });

  it('returns null when no reserved alias is present', () => {
    expect(reservedAliasHint('SELECT COUNT(*) total FROM t')).toBeNull();
    expect(reservedAliasHint('SELECT id, name FROM t')).toBeNull();
  });
});

describe('enrichSqlSyntaxError', () => {
  it('appends a hint to MySQL syntax errors that have a reserved alias', () => {
    const message = "You have an error in your SQL syntax; check the manual ... near 'rows FROM t'";
    const enriched = enrichSqlSyntaxError(message, 'SELECT COUNT(*) rows FROM t');
    expect(enriched).toContain('taproot hint');
    expect(enriched).toContain('`rows`');
  });

  it('leaves non-syntax errors untouched', () => {
    const message = 'Access denied for user';
    expect(enrichSqlSyntaxError(message, 'SELECT COUNT(*) rows FROM t')).toBe(message);
  });

  it('leaves syntax errors without a reserved alias untouched', () => {
    const message = 'You have an error in your SQL syntax near ")"';
    expect(enrichSqlSyntaxError(message, 'SELECT COUNT(*) FROM')).toBe(message);
  });
});
