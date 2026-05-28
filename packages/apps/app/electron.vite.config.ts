import { resolve } from 'path'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { visualizer } from 'rollup-plugin-visualizer'
import { loadEnv, type Plugin } from 'vite'
import { buildCspFloor } from './src/main/renderer-csp'

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
function cspFloorPlugin(dev: boolean): Plugin {
  return {
    name: 'slayzone:csp-floor',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: buildCspFloor(dev) },
          injectTo: 'head-prepend'
        }
      ]
    }
  }
}

// Strip sourcemaps post-hoc to cut V8 parse/decode overhead during dev
// cold-start + HMR. Dev only (apply: 'serve') — prod keeps full maps for Sentry.
function stripDevSourcemapsPlugin(): Plugin {
  return {
    name: 'slayzone:strip-dev-sourcemaps',
    apply: 'serve',
    enforce: 'post',
    transform(code) {
      return { code, map: null }
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

  // In dev, alias react/react-dom to their production CJS bundles to cut
  // render cost (no dev invariants, no Object.freeze on props/state, no
  // rules-of-hooks validation overhead). HMR is disabled (server.hmr: false)
  // so the react-refresh incompatibility with prod React doesn't apply.
  // Regex aliases = exact match only, no prefix mangling of subpath imports.
  // Absolute paths bypass React 19's exports map which doesn't expose ./cjs/*.
  // SLAYZONE_REACT_DEV=1 opts out. SLAYZONE_PROFILE=1 also opts out.
  const useReactProdInDev =
    mode !== 'production' && env.SLAYZONE_REACT_DEV !== '1' && env.SLAYZONE_PROFILE !== '1'

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
      server: {
        // HMR disabled — prod React (used for perf) strips the DevTools
        // internals react-refresh needs for targeted component hot-reload.
        // Full page reload still happens automatically via Vite on file change.
        hmr: false
      },
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
        // Array form required for regex — string alias keys are prefix-based
        // in Vite and would mangle subpath imports (e.g. 'react' → 'react/jsx-runtime').
        alias: [
          { find: '@renderer', replacement: resolve('src/renderer/src') },
          { find: '@', replacement: resolve('src/renderer/src') },
          { find: 'convex/_generated', replacement: resolve(root, 'convex/_generated') },
          { find: 'posthog-js', replacement: 'posthog-js/dist/module.no-external.js' },
          // When SLAYZONE_PROFILE=1, swap to React's profiling builds so the
          // <Profiler> component actually fires onRender in production builds.
          // Otherwise React strips Profiler to a no-op in prod and the perf
          // harness sees zero commits.
          ...(env.SLAYZONE_PROFILE === '1'
            ? [
                { find: 'react-dom/client', replacement: 'react-dom/profiling' },
                { find: 'scheduler/tracing', replacement: 'scheduler/tracing-profiling' }
              ]
            : []),
          ...(useReactProdInDev
            ? [
                { find: /^react$/, replacement: resolve(root, 'node_modules/react/cjs/react.production.js') },
                { find: /^react\/jsx-runtime$/, replacement: resolve(root, 'node_modules/react/cjs/react-jsx-runtime.production.js') },
                { find: /^react\/jsx-dev-runtime$/, replacement: resolve(root, 'node_modules/react/cjs/react-jsx-dev-runtime.development.js') },
                { find: /^react-dom$/, replacement: resolve(root, 'node_modules/react-dom/cjs/react-dom.production.js') },
                { find: /^react-dom\/client$/, replacement: resolve(root, 'node_modules/react-dom/cjs/react-dom-client.production.js') }
              ]
            : [])
        ]
      },
      ...(useReactProdInDev ? { esbuild: { jsxDev: false } } : {}),
      plugins: [
        // Babel + React Compiler in all modes — auto-memoization cuts re-renders
        // in both dev and prod. No SWC: compiler has no SWC equivalent.
        react({ babel: { plugins: ['babel-plugin-react-compiler'] } }),
        tailwindcss(),
        cspFloorPlugin(mode !== 'production'),
        stripDevSourcemapsPlugin(),
        // Bundle analyzer is a rollup plugin; only useful at build time.
        mode === 'production' &&
          visualizer({ filename: 'bundle-report.html', gzipSize: true, template: 'treemap' })
      ],
      optimizeDeps: {
        exclude: slayzoneDeps,
        entries: discoverDomainClientEntries(),
        ...(useReactProdInDev
          ? { esbuildOptions: { define: { 'process.env.NODE_ENV': '"production"' } } }
          : {})
      }
    }
  }
})
