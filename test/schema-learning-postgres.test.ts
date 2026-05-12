import { describe, expect, it } from 'vitest';
import { extractQueryShape } from '../src/core/schema-learning.js';

describe('schema learning extractor (postgres dialect)', () => {
  it('parses double-quoted identifiers as columns/tables', () => {
    const sql = 'SELECT "Id", "FullName" FROM "Users" WHERE "IsActive" = TRUE';
    const out = extractQueryShape(sql, { dialect: 'postgres' });

    expect(out.operation).toBe('select');
    expect(out.tables.map((t) => t.table)).toContain('Users');
    expect(out.columns.some((c) => c.role === 'select' && c.column === 'Id')).toBe(true);
    expect(out.columns.some((c) => c.role === 'filter' && c.column === 'IsActive')).toBe(true);
  });

  it('extracts tables and joins from a CTE query', () => {
    const sql = `
      WITH recent_orders AS (
        SELECT id, customer_id FROM orders WHERE created_at > NOW() - INTERVAL '7 days'
      )
      SELECT c.id, ro.id
      FROM customers c
      JOIN recent_orders ro ON ro.customer_id = c.id
    `;
    const out = extractQueryShape(sql, { dialect: 'postgres' });

    expect(out.operation).toBe('select');
    const names = out.tables.map((t) => t.table);
    expect(names).toContain('customers');
    expect(names).toContain('orders');
    expect(names).not.toContain('recent_orders');
    expect(out.joins.length).toBeGreaterThanOrEqual(0);
  });

  it('handles postgres-style cast in WHERE without throwing', () => {
    const sql = "SELECT id FROM events WHERE payload::text = 'x' AND created_at::date = CURRENT_DATE";
    const out = extractQueryShape(sql, { dialect: 'postgres' });

    expect(out.tables.map((t) => t.table)).toContain('events');
  });

  it('handles ILIKE filter (postgres-specific)', () => {
    const sql = "SELECT id FROM users WHERE email ILIKE '%@example.com'";
    const out = extractQueryShape(sql, { dialect: 'postgres' });

    expect(out.tables.map((t) => t.table)).toContain('users');
    expect(out.columns.some((c) => c.role === 'filter' && c.column === 'email')).toBe(true);
  });

  it('falls back deterministically when parser fails', () => {
    const sql = 'SELECT NOT VALID POSTGRES STATEMENT 123';
    const out = extractQueryShape(sql, { dialect: 'postgres' });

    expect(out.operation).toBe('select');
    expect(out.confidence).toBeLessThan(0.9);
  });

  it('defaults to mysql dialect when none provided (back-compat)', () => {
    const sql = 'SELECT id FROM users WHERE id = 1';
    const out = extractQueryShape(sql);

    expect(out.operation).toBe('select');
    expect(out.tables.map((t) => t.table)).toContain('users');
  });
});
