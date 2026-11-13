/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backend = process.env.PDFEDIT_BACKEND ?? 'http://127.0.0.1:3101'

export default defineConfig({
  plugins: [react()],
  build: { chunkSizeWarningLimit: 2500 },
  server: {
    port: 5180,
    proxy: { '/api': { target: backend, changeOrigin: true } },
  },
  test: { environment: 'jsdom', globals: true },
})
