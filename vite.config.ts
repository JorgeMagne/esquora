import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { global: 'globalThis' },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
      // Servidor desechable de la fase 0 (scripts/spikes/pollar-server.ts)
      '/spike': { target: 'http://localhost:8788', changeOrigin: false },
    },
  },
})
