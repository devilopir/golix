import { defineConfig } from 'vite';

export default defineConfig({
  base: '/headless/',
  publicDir: false,
  // HBInit loads these only for Node or a room without a lobby; the page always has one.
  build: { outDir: '../dist', emptyOutDir: true, rolldownOptions: { external: ['@golix/server', 'node-datachannel/polyfill'] } },
});
