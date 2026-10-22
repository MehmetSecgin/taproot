import fs from 'node:fs';
import type { AppContext } from './app.js';
import { writeJsonFile } from './json.js';

const STARTER_RUNTIME_CONFIG = {
  environmentPolicies: {},
  serviceAliases: {},
};

export function ensureStarterRuntime(ctx: Pick<AppContext, 'paths'>): boolean {
  if (fs.existsSync(ctx.paths.runtimeConfigFile)) return false;
  writeJsonFile(ctx.paths.runtimeConfigFile, STARTER_RUNTIME_CONFIG);
  return true;
}

