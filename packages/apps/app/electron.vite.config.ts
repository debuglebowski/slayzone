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

  // In dev, run React's PRODUCTION build to cut render cost (no dev invariants,
  // no Object.freeze on props/state, no rules-of-hooks validation overhead).
  // Achieved with ONE mechanism: optimizeDeps.esbuildOptions.define sets
  // NODE_ENV=production at pre-bundle time, so the optimized react/react-dom
  // chunks resolve to their cjs/*.production builds. Source and every
  // pre-bundled dep (convex/react, @convex-dev/auth/react) then share that one
  // optimized React instance.
  //
  // Do NOT also alias react/* to the on-disk cjs/*.production files: that serves
  // source a SECOND React copy (bypassing .vite/deps) while deps keep the
  // optimized one → two ReactCurrentDispatcher registries → hooks throw inside
  // ConvexAuthProvider ("Cannot read properties of null (reading 'useMemo')").
  // Do NOT add a top-level `define: process.env.NODE_ENV` either — it would
  // rewrite Vite's react-refresh runtime to its no-op prod stub.
  //
  // SLAYZONE_REACT_DEV=1 opts out (real dev React). SLAYZONE_PROFILE=1 also opts
  // out (needs dev/profiling React for <Profiler>).
  const useReactProdInDev =
    mode !== 'production' && env.SLAYZONE_REACT_DEV !== '1' && env.SLAYZONE_PROFILE !== '1'

  return {
    main: {
      plugins: [externalizeDepsPlugin({ exclude: slayzoneDeps })],
      build: {
        rollupOptions: {
          input: {
            index: resolve('src/main/index.ts'),
            // SQLite worker threads — bundled as separate entries so they can be
            // spawned via `new Worker(join(__dirname, 'db-worker.js'))`. They
            // import only worker-safe modules (no node-pty/electron).
            'db-worker': resolve('src/main/db/db-worker.ts'),
            'diag-worker': resolve('src/main/db/diag-worker.ts')
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
      // HMR channel stays ENABLED. Under prod React, react-refresh is an inert
      // no-op (prod react-dom omits scheduleRefresh, so performReactRefresh does
      // nothing — no targeted hot-reload, but it never throws). The channel is
      // still needed for Vite's full-reload on dep re-optimize: with the
      // renderer's many lazy imports, a first-time lazy dep triggers a runtime
      // re-optimize, and without the reload signal the page would keep stale
      // dep URLs mixed with fresh ones → multiple React copies again.
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
      // Emit jsx() not jsxDEV(): the prod NODE_ENV define (below) makes
      // react/jsx-dev-runtime resolve to a stub WITHOUT jsxDEV, so leaving
      // jsxDev on would throw "jsxDEV is not a function". jsx() → jsx-runtime,
      // which the same define resolves to its production build.
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
        // The sole prod-React-in-dev lever: bakes NODE_ENV=production into the
        // pre-bundled deps so react/react-dom resolve to their cjs/*.production
        // builds. Scoped to the dep optimizer only — does NOT touch Vite's
        // react-refresh runtime (which must stay dev to keep HMR functional).
        ...(useReactProdInDev
          ? { esbuildOptions: { define: { 'process.env.NODE_ENV': '"production"' } } }
          : {})
      }
    }
  }
})
