import { resolve } from 'path'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import reactSwc from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'
import { visualizer } from 'rollup-plugin-visualizer'
import { loadEnv, type Plugin } from 'vite'
import { RENDERER_CSP_FLOOR } from './src/main/renderer-csp'

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))
const slayzoneDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) =>
  d.startsWith('@slayzone/')
)

const root = resolve(__dirname, '../../..')

// Discover @slayzone/* client entry files so Vite's dep scanner can trace
// through them and pre-bundle their third-party imports automatically.
// Injects the renderer Content-Security-Policy floor as a <meta> tag. The main
// process emits an exact-port CSP header at runtime (see main/renderer-csp.ts);
// this build-time floor guarantees the document always has a policy even if
// that header never lands. Both layers are built from the same source module.
function cspFloorPlugin(): Plugin {
  return {
    name: 'slayzone:csp-floor',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: RENDERER_CSP_FLOOR },
          injectTo: 'head-prepend'
        }
      ]
    }
  }
}

function discoverDomainClientEntries(): string[] {
  const entries: string[] = []
  const dirs = [resolve(root, 'packages/domains'), resolve(root, 'packages/shared')]
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
            index: resolve('src/main/index.ts')
          },
          external: ['better-sqlite3', 'node-pty', 'posix']
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
            'browser-chrome-preload': resolve('src/preload/browser-chrome-preload.ts')
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
        __POSTHOG_API_KEY__: JSON.stringify(
          env.POSTHOG_DISABLED === '1'
            ? ''
            : (env.POSTHOG_API_KEY ?? 'phc_b66nL6IJ3JhzrOEh98Tdk857rRYuoqWMmQmWShSnstV')
        ),
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
            ? {
                'react-dom/client': 'react-dom/profiling',
                'scheduler/tracing': 'scheduler/tracing-profiling'
              }
            : {})
        }
      },
      plugins: [
        // Dev uses the SWC (Rust) React transform for Fast Refresh — ~20x
        // faster per .tsx than Babel, cutting cold-start and HMR latency.
        // Prod stays on Babel `plugin-react`: the React Compiler memoization
        // pass is a Babel plugin with no SWC equivalent, and it only matters
        // for prod-runtime memoization anyway.
        mode === 'production'
          ? react({ babel: { plugins: ['babel-plugin-react-compiler'] } })
          : reactSwc(),
        tailwindcss(),
        cspFloorPlugin(),
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
