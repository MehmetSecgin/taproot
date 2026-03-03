import { describe, expect, it } from 'vitest';
import { registerCleanup, runRegisteredCleanup } from '../src/core/cleanup.js';

describe('cleanup registry', () => {
  it('runs cleanup handlers in reverse registration order', async () => {
    const out: string[] = [];
    registerCleanup('a', () => {
      out.push('a');
    });
    registerCleanup('b', () => {
      out.push('b');
    });
    await runRegisteredCleanup();
    expect(out).toEqual(['b', 'a']);
  });

  it('supports unregistering handlers', async () => {
    const out: string[] = [];
    const unregister = registerCleanup('x', () => {
      out.push('x');
    });
    unregister();
    await runRegisteredCleanup();
    expect(out).toEqual([]);
  });
});
