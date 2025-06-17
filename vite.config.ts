import { defineConfig } from 'vite'

export default defineConfig({
  base: './', // Для относительных путей
  build: {
    outDir: 'dist',
    assetsDir: 'assets'
  },
  define: {
    // Переменные окружения для продакшена
    'import.meta.env.VITE_APP_ACCESS_KEY': JSON.stringify(process.env.VITE_APP_ACCESS_KEY),
    'import.meta.env.VITE_HEYGEN_API_KEY': JSON.stringify(process.env.VITE_HEYGEN_API_KEY),
    'import.meta.env.VITE_HEYGEN_KB_ID': JSON.stringify(process.env.VITE_HEYGEN_KB_ID)
  }
})