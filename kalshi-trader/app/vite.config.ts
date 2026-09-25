import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API = 'http://127.0.0.1:8099';

/**
 * The React app (`src/web`) builds into `dist/web`, which Fastify serves. `base: './'` keeps every
 * URL relative, so the same build works at `/` and under a Home Assistant ingress prefix (the server
 * rewrites `<base href>` and the entry URLs per request, see `src/server/web.ts`).
 *
 * `npm run dev:web` serves the app with hot reload on :5173 and proxies the API to `npm run dev` on :8099.
 */
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/web'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist/web'),
    emptyOutDir: true,
    sourcemap: false,
    assetsDir: 'assets',
    // Keep every asset a file: `data:` URLs would need a looser CSP for fonts and styles.
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API },
      '/auth': { target: API },
      '/healthz': { target: API },
      // Page loads of /login and /setup are the SPA; their form posts go to the server.
      '^/(login|setup)$': { target: API, bypass: (req) => (req.method === 'GET' ? req.url : undefined) },
    },
  },
});
