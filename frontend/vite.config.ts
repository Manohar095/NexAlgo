import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

/**
 * CogniX trading chart — a *sub-app* build of OpenAlgoNew's trading page.
 *
 * Only `pages/Trading` (and the 159-file module graph it imports) is mounted;
 * everything else in `src` is carried along untouched so the page compiles
 * without edits. Output lands in `../static/trading-app/` and is served by
 * FastAPI at `/trading-app/` (the page itself at `/trading`).
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { global: 'globalThis' },
  // Served from FastAPI's public `/static/` mount (the auth middleware lets
  // that prefix through unauthenticated, so the hashed assets load before the
  // cookie is checked — the page route itself stays gated).
  base: '/static/trading-app/',
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/alerts': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/admin': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/auth': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8000', ws: true },
    },
  },
  build: {
    outDir: '../static/trading-app',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/.test(id)) return 'react-vendor'
          if (id.includes('tanstack/react-query')) return 'tanstack'
        },
      },
    },
  },
})
