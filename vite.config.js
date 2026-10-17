import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { archiveHtml } from './build/archive-html.mjs'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), archiveHtml(loadEnv(mode, '.', 'VITE_').VITE_SITE_URL), {
    name: 'nodus-room-index',
    configureServer(server) { server.middlewares.use((req, _res, next) => { if (req.url?.split('?')[0] === '/nodus/') req.url = req.url.replace('/nodus/', '/nodus/index.html'); next() }) },
  }],
  server: {
    host: '127.0.0.1', port: 5175, strictPort: true,
    proxy: {'/api/nodus': {target: 'http://127.0.0.1:8794', changeOrigin: true, xfwd: false, rewrite: path => path.replace(/^\/api\/nodus/, '')}},
  },
}))
