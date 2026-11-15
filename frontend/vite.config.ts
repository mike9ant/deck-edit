/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'

const backend = process.env.DECKEDIT_BACKEND ?? 'http://127.0.0.1:3101'

/**
 * Builds don't empty dist/ (see emptyOutDir), so a page loaded before a rebuild
 * can still fetch its lazily loaded chunks (e.g. ExcelJS) under their old
 * hashed names. Chunks no build has written for a week are removed here.
 */
function pruneOldAssets(maxAgeDays = 7): Plugin {
  return {
    name: 'prune-old-assets',
    apply: 'build',
    closeBundle() {
      const dir = resolve(__dirname, 'dist/assets')
      const cutoff = Date.now() - maxAgeDays * 86_400_000
      let names: string[] = []
      try { names = readdirSync(dir) } catch { return }
      for (const name of names) {
        const file = join(dir, name)
        if (statSync(file).mtimeMs < cutoff) unlinkSync(file)
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), pruneOldAssets()],
  build: { chunkSizeWarningLimit: 2500, emptyOutDir: false },
  server: {
    port: 5180,
    proxy: { '/api': { target: backend, changeOrigin: true } },
  },
  test: { environment: 'jsdom', globals: true },
})
