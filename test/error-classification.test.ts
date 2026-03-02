import { describe, expect, it } from 'vitest';
import { classifyError } from '../src/core/app.js';
import { EXIT_CODES, exitCodeForClass } from '../src/core/exit-codes.js';

describe('error classification', () => {
  it('maps ECONNREFUSED to CONNECTIVITY', () => {
    expect(classifyError('connect ECONNREFUSED 127.0.0.1:4406')).toBe('CONNECTIVITY');
    expect(exitCodeForClass('CONNECTIVITY')).toBe(EXIT_CODES.CONNECTIVITY);
  });

  it('maps permission errors to ACCESS_DENIED', () => {
    expect(classifyError('Access denied for user')).toBe('ACCESS_DENIED');
    expect(exitCodeForClass('ACCESS_DENIED')).toBe(EXIT_CODES.ACCESS_DENIED);
  });
});
