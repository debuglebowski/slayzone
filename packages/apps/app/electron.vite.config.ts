import { resolve } from 'path'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { visualizer } from 'rollup-plugin-visualizer'
import { loadEnv } from 'vite'

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))
const slayzoneDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) =>
  d.startsWith('@slayzone/')
)

const root = resolve(__dirname, '../../..')

// Discover @slayzone/* client entry files so Vite's dep scanner can trace
// through them and pre-bundle their third-party imports automatically.
function discoverDomainClientEntries(): string[] {
  const entries: string[] = []
  const dirs = [
    resolve(root, 'packages/domains'),
    resolve(root, 'packages/shared')
  ]
  for (const base of dirs) {
    if (!existsSync(base)) continue
    for (const pkg of readdirSync(base, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      for (const candidate of [
        resolve(base, pkg.name, 'src/client/index.ts'),
        resolve(base, pkg.name, 'src/client/index.tsx'),
        resolve(base, pkg.name, 'src/index.ts'),
        resolve(base, pkg.name, 'src/index.tsx')
      ]) {
        if (existsSync(candidate)) {
          entries.push(candidate)
          break
        }
      }
    }
  }
  return entries
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, '')

  return {
    main: {
      plugins: [externalizeDepsPlugin({ exclude: slayzoneDeps })],
      build: {
        rollupOptions: {
          input: {
            index: resolve('src/main/index.ts'),
          },
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
            'browser-chrome-preload': resolve('src/preload/browser-chrome-preload.ts'),
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
      define: {
        __POSTHOG_API_KEY__: JSON.stringify(env.POSTHOG_DISABLED === '1' ? '' : (env.POSTHOG_API_KEY ?? 'phc_b66nL6IJ3JhzrOEh98Tdk857rRYuoqWMmQmWShSnstV')),
        __POSTHOG_HOST__: JSON.stringify(env.POSTHOG_HOST ?? 'https://eu.i.posthog.com'),
        __DEV__: JSON.stringify(mode !== 'production'),
        __SLAYZONE_PROFILE__: JSON.stringify(env.SLAYZONE_PROFILE === '1')
      },
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src'),
          '@': resolve('src/renderer/src'),
          'convex/_generated': resolve(root, 'convex/_generated'),
          'posthog-js': 'posthog-js/dist/module.no-external.js',
          // When SLAYZONE_PROFILE=1, swap to React's profiling builds so the
          // <Profiler> component actually fires onRender in production builds.
          // Otherwise React strips Profiler to a no-op in prod and the perf
          // harness sees zero commits.
          ...(env.SLAYZONE_PROFILE === '1'
            ? { 'react-dom/client': 'react-dom/profiling', 'scheduler/tracing': 'scheduler/tracing-profiling' }
            : {})
        }
      },
      plugins: [
        // React Compiler runs babel AST analysis on every .tsx. Its purpose is
        // prod-runtime memoization injection, so gate it to prod builds only
        // — saves several seconds on dev cold start + 50-200ms per HMR cycle.
        react({
          babel: {
            plugins: mode === 'production' ? ['babel-plugin-react-compiler'] : []
          }
        }),
        tailwindcss(),
        // Bundle analyzer is a rollup plugin; only useful at build time.
        mode === 'production' &&
          visualizer({ filename: 'bundle-report.html', gzipSize: true, template: 'treemap' })
      ],
      optimizeDeps: {
        exclude: slayzoneDeps,
        entries: discoverDomainClientEntries()
      }
    }
  }
})
