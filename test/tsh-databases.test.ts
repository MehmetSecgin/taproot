import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { fetchTshDatabases } from '../src/plugins-builtins/teleport-mysql/tsh-databases.js';

describe('tsh database listing', () => {
  it('keeps the event loop free while tsh db ls runs', async () => {
    // arrange
    const tshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-tsh-slow-'));
    const tshPath = path.join(tshDir, 'tsh');
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
