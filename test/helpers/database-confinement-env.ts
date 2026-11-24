import { afterEach, beforeEach } from 'vitest';
import { restoreProcessEnv } from './query-state.js';

const savedConfine = process.env.TAPROOT_CONFINE_TO_DATABASE;

export function useDatabaseConfinement(): void {
  beforeEach(() => {
    process.env.TAPROOT_CONFINE_TO_DATABASE = '1';
  });

  afterEach(() => {
    restoreProcessEnv();
    if (savedConfine === undefined) {
      Reflect.deleteProperty(process.env, 'TAPROOT_CONFINE_TO_DATABASE');
    } else {
      process.env.TAPROOT_CONFINE_TO_DATABASE = savedConfine;
    }
  });
}
