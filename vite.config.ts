import { defineConfig } from 'vite';

export default defineConfig({
  // Relative, so the build works from any GitHub Pages sub-path without reconfiguration.
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
});
