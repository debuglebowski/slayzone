import { resolve } from 'path'
import { readFileSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { loadEnv } from 'vite'

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))
const slayzoneDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) =>
  d.startsWith('@slayzone/')
)

const root = resolve(__dirname, '../../..')

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, '')
  const devHost = env.SLAYZONE_DEV_HOST || '127.0.0.1'
  const parsedDevPort = Number.parseInt(env.SLAYZONE_DEV_PORT || '5173', 10)
  const devPort = Number.isFinite(parsedDevPort) ? parsedDevPort : 5173

  return {
    main: {
      plugins: [externalizeDepsPlugin({ exclude: slayzoneDeps })],
      build: {
        rollupOptions: {
          external: ['better-sqlite3', 'node-pty']
        }
      }
    },
    preload: {
      plugins: [externalizeDepsPlugin({ exclude: slayzoneDeps })],
      build: {
        rollupOptions: {
          input: {
            index: resolve('src/preload/index.ts'),
            'webview-preload': resolve('src/preload/webview-preload.ts'),
          },
          output: {
            format: 'cjs',
            entryFileNames: '[name].js'
          }
        }
      }
    },
    renderer: {
      envDir: root,
      server: {
        host: devHost,
        port: devPort,
        strictPort: false
      },
      define: {
        __POSTHOG_API_KEY__: JSON.stringify(env.POSTHOG_API_KEY ?? ''),
        __POSTHOG_HOST__: JSON.stringify(env.POSTHOG_HOST ?? ''),
        __DEV__: JSON.stringify(mode !== 'production'),
        __POSTHOG_DEV_ENABLED__: JSON.stringify(env.POSTHOG_DEV_ENABLED === '1')
      },
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src'),
          '@': resolve('src/renderer/src'),
          'convex/_generated': resolve(root, 'convex/_generated'),
          'posthog-js': 'posthog-js/dist/module.no-external.js'
        }
      },
      plugins: [react(), tailwindcss()],
      optimizeDeps: {
        exclude: slayzoneDeps
      }
    }
  }
})
