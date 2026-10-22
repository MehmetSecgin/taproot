import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { fetchTshDatabases } from '../src/core/tsh-databases.js';

describe('fetchTshDatabases', () => {
  it('keeps the event loop free while tsh db ls runs', async () => {
    // arrange
    const tshPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-tsh-slow-')), 'tsh');
    fs.writeFileSync(tshPath, `#!/bin/sh\nsleep 0.3\necho '[{"metadata":{"name":"orders-tidb"}}]'\n`);
    fs.chmodSync(tshPath, 0o755);
    let ticked = false;
    setTimeout(() => {
      ticked = true;
    }, 20);

    // act
    const result = await fetchTshDatabases({ tshPath });

    // assert
    expect(ticked).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.databases).toHaveLength(1);
  });
});
