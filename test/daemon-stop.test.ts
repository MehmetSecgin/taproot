import { describe, expect, it } from 'vitest';
import { parseJson } from './helpers/parse-json.js';
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
    expect(parseJson(out.stdout)).toStrictEqual({ ok: true, data: { running: false } });
  });
});
