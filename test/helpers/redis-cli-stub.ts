import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onTestFinished } from 'vitest';

export function stubRedisCli(script: string): string {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-redis-cli-'));
  const file = path.join(binDir, 'redis-cli');
  fs.writeFileSync(file, `#!/bin/sh\n${script}`);
  fs.chmodSync(file, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:/usr/bin:/bin`;
  onTestFinished(() => {
    process.env.PATH = originalPath;
  });
  return binDir;
}
