import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['.claude/**', 'dist/**', 'node_modules/**'],
    env: { TAPROOT_NO_KEYCHAIN: '1' },
  },
});
