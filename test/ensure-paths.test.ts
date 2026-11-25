import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensurePaths } from '../src/core/paths.js';
import { tempStateRoot } from './helpers/state-root.js';

describe('creating the state directories', () => {
  it('tightens an existing config dir to owner-only access', () => {
    // arrange
    const { stateRoot, configDir } = tempStateRoot();
    fs.chmodSync(configDir, 0o755);

    // act
    ensurePaths({
      stateRoot,
      configDir,
      runtimeConfigFile: path.join(configDir, 'deterministic-config.json'),
      datasourceFile: path.join(configDir, 'datasources.json'),
      credentialFile: path.join(configDir, 'credentials.json.enc'),
      cacheDir: path.join(stateRoot, 'cache'),
      kbDir: path.join(stateRoot, 'kb'),
    });

    // assert
    expect(fs.statSync(configDir).mode.toString(8).slice(-3)).toBe('700');
  });
});
