import { describe, expect, it } from 'vitest';
import { runCli } from './helpers/cli.js';
import { tempStateRoot } from './helpers/state-root.js';

describe('daemon stop', () => {
  it('reports running false when no daemon is running', () => {
    // arrange
    const { stateRoot } = tempStateRoot();

    // act
    const out = runCli(['daemon', 'stop'], { TAPROOT_STATE_ROOT: stateRoot });

    // assert
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ ok: true, data: { running: false } });
  });
});
