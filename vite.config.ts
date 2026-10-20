import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Renderer build. Loaded from file:// in production, so assets use relative paths.
export default defineConfig({
  root: 'src',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../dist/renderer',
    emptyOutDir: true,
    target: 'chrome150',
    sourcemap: true,
  },
  server: { port: 5199, strictPort: true },
});
