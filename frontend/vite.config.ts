import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// 开发联调：VITE_API_TARGET 指向本地 Node 后端（默认 http://localhost:8080）。
// 生产部署时前端由 Node 后端同源 serve（dist/ -> 后端 public/），不需要代理。
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:8080',
        changeOrigin: true
      },
      '/socket.io': {
        target: process.env.VITE_API_TARGET || 'http://localhost:8080',
        ws: true,
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})
