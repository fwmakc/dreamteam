import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(import.meta.dirname),
  plugins: [vue()],
  build: {
    outDir: resolve(import.meta.dirname, '..', 'gui-dist'),
    emptyOutDir: true,
  },
});
