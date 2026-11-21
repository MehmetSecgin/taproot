import { defineConfig } from 'tsup';

const PLUGINS = ['mysql', 'redis', 'grpc', 'teleport', 'teleport-mysql', 'kubectl-portforward'];

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'daemon-main': 'src/daemon-main.ts',
    core: 'src/api/core.ts',
    daemon: 'src/api/daemon.ts',
    cli: 'src/api/cli.ts',
    ...Object.fromEntries(PLUGINS.map((plugin) => [`plugins/${plugin}`, `src/api/plugins/${plugin}.ts`])),
  },
  format: 'esm',
  dts: true,
  outDir: 'dist',
  clean: true,
  external: ['keytar'],
});
