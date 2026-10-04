import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'

const port = Number(process.env.PORT ?? 4310)

export default defineConfig({
  server: {
    port,
    strictPort: true,
    host: '127.0.0.1',
    watch: {
      // The SQLite file and Playwright's output live inside the project root.
      // Without this every database write wakes the file watcher.
      ignored: ['**/data/**', '**/test-results/**', '**/playwright-report/**'],
    },
  },
  plugins: [
    tanstackStart(),
    // react's vite plugin must come after start's vite plugin
    viteReact(),
  ],
})
