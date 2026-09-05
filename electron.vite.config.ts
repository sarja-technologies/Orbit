import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const alias = {
  '@main': resolve('src/main'),
  '@preload': resolve('src/preload'),
  '@renderer': resolve('src/renderer'),
  '@shared': resolve('src/shared')
}

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      rollupOptions: {
        input: resolve('src/main/index.ts'),
        external: ['electron', 'sql.js']
      }
    }
  },
  preload: {
    resolve: { alias },
    build: {
      rollupOptions: {
        input: resolve('src/preload/index.ts'),
        external: ['electron'],
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs'
        }
      }
    }
  },
  renderer: {
    resolve: { alias },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve('src/renderer/index.html')
      }
    }
  }
})
