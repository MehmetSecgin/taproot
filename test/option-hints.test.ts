import { describe, expect, it } from 'vitest';
import { unknownOptionHint } from '../src/core/option-hints.js';

const owners = { '--pluck': [''], '--timeout': ['query'], '--datasource': ['query', 'doctor'], '--allow-mutate': ['query', 'datasource add'] };

describe('explaining an unknown option', () => {
  it('names the subcommand that owns an option placed before it', () => {
    // act
    const hint = unknownOptionHint("error: unknown option '--timeout'", owners, { argv: ['--timeout', '5000', 'query'], programName: 'taproot' });
    // assert
    expect(hint).toBe("option '--timeout' belongs to 'taproot query'; put it after the subcommand: taproot query --timeout ...");
  });

  it('uses the owner the user typed in the placement example', () => {
    const hint = unknownOptionHint("error: unknown option '--allow-mutate'", owners, { argv: ['--allow-mutate', 'datasource', 'add'], programName: 'taproot' });
    expect(hint).toBe("option '--allow-mutate' belongs to 'taproot query', 'taproot datasource add'; put it after the subcommand: taproot datasource add --allow-mutate ...");
  });

  it('uses the first owner in the placement example when the user typed it', () => {
    const hint = unknownOptionHint("error: unknown option '--allow-mutate'", owners, { argv: ['--allow-mutate', 'query'], programName: 'taproot' });
    expect(hint).toBe("option '--allow-mutate' belongs to 'taproot query', 'taproot datasource add'; put it after the subcommand: taproot query --allow-mutate ...");
  });

  it('names the owner without placement advice when the option follows another subcommand', () => {
    const hint = unknownOptionHint("error: unknown option '--timeout'", owners, { argv: ['datasource', 'list', '--timeout', '5000'], programName: 'taproot' });
    expect(hint).toBe("'--timeout' is an option of 'taproot query'");
  });

  it('names the owner without placement advice when the option precedes a subcommand that does not own it', () => {
    const hint = unknownOptionHint("error: unknown option '--timeout'", owners, { argv: ['--timeout', '5000', 'doctor'], programName: 'taproot' });
    expect(hint).toBe("'--timeout' is an option of 'taproot query'");
  });

  it('says to split an option glued to its value', () => {
    const hint = unknownOptionHint("error: unknown option '--datasource qa-orders'", owners, { argv: ['query', '--datasource qa-orders'], programName: 'taproot' });
    expect(hint).toContain("option '--datasource' and its value arrived as one argument");
  });

  it('says to split a global option glued to its value', () => {
    expect(unknownOptionHint("error: unknown option '--pluck data.rows'", owners, { argv: ['query', '--pluck data.rows'], programName: 'taproot' })).toContain('arrived as one argument');
  });

  it('stays silent for an option no command knows', () => {
    expect(unknownOptionHint("error: unknown option '--bogus'", owners, { argv: ['query', '--bogus'], programName: 'taproot' })).toBeUndefined();
    expect(unknownOptionHint("error: unknown option '--bogus value'", owners, { argv: ['query', '--bogus value'], programName: 'taproot' })).toBeUndefined();
  });
});
