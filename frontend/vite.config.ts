/// <reference types="vitest" />
import fs from 'fs'
import path from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// v2026-07-24: copy the repo-root CHANGELOG.md into frontend/src so ChangelogPage.tsx
// can import it via `?raw`. Keeps a single source of truth at the repo root (edited
// like any other doc) without relying on symlinks (which break on Windows) or on
// Vite `server.fs.allow` gymnastics (which don't help for `?raw` imports outside
// the project root reliably across dev / build / preview).
function copyChangelogPlugin() {
  const src = path.resolve(__dirname, '../CHANGELOG.md')
  const dst = path.resolve(__dirname, 'src/CHANGELOG.md')
  const copyIfChanged = () => {
    try {
      const s = fs.readFileSync(src, 'utf8')
      let d = ''
      try { d = fs.readFileSync(dst, 'utf8') } catch { /* first run */ }
      if (s !== d) fs.writeFileSync(dst, s, 'utf8')
    } catch (err) {
      console.warn('[copyChangelog] failed:', err)
    }
  }
  return {
    name: 'copy-changelog',
    // Run at both config resolution (so it's in place before the module graph is built)
    // and whenever the source changes in dev.
    configResolved() { copyIfChanged() },
    configureServer(server: any) {
      copyIfChanged()
      server.watcher.add(src)
      server.watcher.on('change', (file: string) => {
        if (path.resolve(file) === src) copyIfChanged()
      })
    },
  }
}

export default defineConfig({
  plugins: [copyChangelogPlugin(), react()],
  base: '/sentiment/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Proxy all /api calls to the FastAPI backend in dev
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
})
