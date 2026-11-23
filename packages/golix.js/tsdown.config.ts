import { defineConfig } from 'tsdown';

// The workspace packages are dev dependencies, so they are bundled in; node-datachannel and ws stay external.
export default defineConfig({
  entry: 'src/index.ts',
  format: ['esm', 'cjs'],
  platform: 'node',
  dts: { generator: 'oxc' },
  exports: true,
  deps: { alwaysBundle: [/^@golix\//], onlyBundle: [/^@golix\//, 'json5'] },
});
