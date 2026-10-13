/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// ── Deployment knobs ─────────────────────────────────────────────────────────
// base      : '/' for local+docker, '/llm-infra-planner/' for GitHub Pages root,
//             plus '/dev/' or '/staging/' for the preview environments.
// WASI host : where /api/* is proxied (local runtime host, see scripts/wasi-server.mjs)
// The same bundle therefore serves four targets — see .kiro/specs/13..15.
const base = process.env.VITE_BASE_PATH ?? '/'
const wasiTarget = process.env.WASI_PROXY_TARGET ?? 'http://127.0.0.1:8787'
const proxy = {
  '/api': {
    target: wasiTarget,
    changeOrigin: true,
    // The browser never calls localhost directly — it calls /api/* and the proxy
    // (vite here, nginx in the container image) forwards to the WASI process.
    configure: (proxyServer: { on: (event: string, cb: (...args: unknown[]) => void) => void }) => {
      proxyServer.on('error', (err: unknown) => {
        console.warn('[vite] WASI host unreachable, /api will 502:', (err as Error)?.message)
      })
    },
  },
}

// https://vitejs.dev/config/
export default defineConfig({
  base,
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: Number(process.env.PORT ?? 5173),
    strictPort: false,
    cors: true,
    proxy,
  },
  preview: {
    host: '0.0.0.0',
    port: Number(process.env.PREVIEW_PORT ?? 4173),
    strictPort: false,
    cors: true,
    proxy,
  },
  build: {
    outDir: 'dist',
    sourcemap: process.env.VITE_SOURCEMAP === 'true',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
          math: ['katex'],
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'scripts/**/*.{test,spec}.ts'],
  },
})
