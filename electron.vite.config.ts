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
    resolve: {
      alias: {
        ...alias,
        // @xterm/headless@6.0.0 ships a broken package.json: its "module"
        // field points at a file that doesn't exist in the published
        // package (lib/xterm.mjs), so Vite's resolver fails outright
        // unless pointed straight at the real ESM entry point. Confirmed
        // by inspecting the installed package's actual file layout.
        '@xterm/headless': resolve('node_modules/@xterm/headless/lib-headless/xterm-headless.mjs')
      }
    },
    build: {
      rollupOptions: {
        input: resolve('src/main/index.ts'),
        // node-pty is a native addon (real .node binary) and must run as a
        // real Node require, never bundled — same reasoning as 'sql.js'.
        // @xterm/headless is deliberately NOT external: it's CJS-shaped
        // with no ESM-recognized named exports for Node's own loader, so
        // leaving it external produced a real bundle that imported
        // `{ Terminal }` from it directly and crashed the whole app on
        // launch (confirmed live) — bundling it (now that the alias above
        // makes it resolvable) lets Rollup do the export interop at build
        // time instead.
        external: ['electron', 'sql.js', 'node-pty']
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
