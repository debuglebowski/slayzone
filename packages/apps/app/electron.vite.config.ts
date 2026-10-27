import { resolve } from 'path'
import { readFileSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { visualizer } from 'rollup-plugin-visualizer'
import { loadEnv, type Plugin } from 'vite'
import { runtimeImportsRollupPlugin } from '@slayzone/build-guards/runtime-imports'
import { reactCompilerPlugin } from '@slayzone/react-compiler-config'
import { buildCspFloor } from './src/main/renderer-csp'
import { NO_MODULE_RE, reactCompilerCachePlugin } from './vite/react-compiler-cache'
import { devWatchIgnored, envFilesRestartPlugin } from './vite/dev-watch'

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))
const slayzoneDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) =>
  d.startsWith('@slayzone/')
)

const root = resolve(__dirname, '../../..')

// Fail the main/preload build (dev watch included) when a module their output
// still resolves at runtime would not resolve in the shipped app — e.g. an ESM
// `require('@slayzone/…')`, which Rollup leaves unbundled. See build-guards.
const runtimeImportsGuard = (bundleName: string): Plugin =>
  runtimeImportsRollupPlugin({ bundleName, packageJson: pkg, electron: true }) as Plugin

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
// `{ mappings: '' }` is Vite's explicit "no sourcemap": it collapses the whole
// combined chain and suppresses the fallback map the dev server would inject.
// (`map: null` would mean "positions unchanged" and keep the earlier plugins'
// maps — the full inline maps were still being served.)
function stripDevSourcemapsPlugin(): Plugin {
  return {
    name: 'slayzone:strip-dev-sourcemaps',
    apply: 'serve',
    enforce: 'post',
    transform(code) {
      return { code, map: { mappings: '' } }
    }
  }
}

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, root, '')

  // In dev, run React's PRODUCTION build to cut render cost (no dev invariants,
  // no Object.freeze on props/state, no rules-of-hooks validation overhead).
  // Achieved with ONE mechanism: optimizeDeps.rolldownOptions.transform.define sets
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

  // Dev under prod React: the React Compiler pass runs in
  // slayzone:react-compiler-cache (on-disk cache + worker pool, byte-identical
  // output, no fast refresh — prod react-dom cannot apply it). plugin-react and
  // the compiler plugin keep their config roles (preamble, optimizeDeps incl.
  // react/compiler-runtime) but transform nothing. `vite build` and the
  // real-dev-React modes keep the stock compiler pass, so prod output is untouched.
  const cachedReactCompiler = command === 'serve' && useReactProdInDev

  return {
    main: {
      plugins: [externalizeDepsPlugin({ exclude: slayzoneDeps }), runtimeImportsGuard('app main')],
      // The renderer's Convex deployment (its `import.meta.env.VITE_CONVEX_URL`, read
      // from the same `root` env + mode), so main can hand the hub the one deployment
      // the renderer signs in against (T-99, hub-convex.ts). '' = Convex off.
      define: {
        __SLAYZONE_CONVEX_URL__: JSON.stringify(env.VITE_CONVEX_URL ?? '')
      },
      build: {
        rolldownOptions: {
          input: {
            index: resolve('src/main/index.ts'),
            // SQLite worker threads — bundled as separate entries so they can be
            // spawned via `new Worker(join(__dirname, 'diag-worker.js'))`. It
            // import only worker-safe modules (no node-pty/electron).
            'diag-worker': resolve('src/main/db/diag-worker.ts')
          },
          external: ['better-sqlite3', 'node-pty', 'posix']
        }
      }
    },
    preload: {
      plugins: [
        externalizeDepsPlugin({ exclude: slayzoneDeps }),
        runtimeImportsGuard('app preload')
      ],
      build: {
        rolldownOptions: {
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
      // envDir is the repo root: keep its .env files (and build/test output) out
      // of Vite's chokidar so its FSEvents stream isn't rooted at the repo — see
      // vite/dev-watch.ts. envFilesRestartPlugin keeps env-change → restart.
      server: { watch: { ignored: devWatchIgnored(root, mode) } },
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
      ...(useReactProdInDev ? { oxc: { jsx: { development: false } } } : {}),
      plugins: [
        // Babel + React Compiler in all modes — auto-memoization cuts re-renders
        // in both dev and prod. The setup is shared with vitest.config.ts so the
        // jsdom suites run components compiled exactly as they ship.
        cachedReactCompiler && reactCompilerCachePlugin(),
        react(cachedReactCompiler ? { include: NO_MODULE_RE } : {}),
        reactCompilerPlugin(cachedReactCompiler ? { include: NO_MODULE_RE } : {}),
        tailwindcss(),
        cspFloorPlugin(mode !== 'production'),
        envFilesRestartPlugin(root),
        stripDevSourcemapsPlugin(),
        // Bundle analyzer is a rollup plugin; only useful at build time.
        mode === 'production' &&
          visualizer({ filename: 'bundle-report.html', gzipSize: true, template: 'treemap' })
      ],
      optimizeDeps: {
        // No `entries` / no `exclude` of @slayzone/*: the scanner starts from
        // index.html (Vite's default) and follows every import — static AND
        // lazy `import()` — through the workspace packages. Those resolve (via
        // the symlinks) to packages/*, outside node_modules, so Vite treats them
        // as source and never pre-bundles them; excluding them only stopped the
        // scanner at each package boundary, so third-party deps first imported
        // behind a subpath export (@slayzone/terminal/client/Terminal → @xterm/*,
        // …) were discovered mid-boot → re-optimize → full renderer reload.
        // With the scan complete, nothing is left to discover while crawling, so
        // don't hold optimized-dep responses until the static crawl ends (Vite's
        // documented setting for a scanner that finds every dep).
        holdUntilCrawlEnd: false,
        // The sole prod-React-in-dev lever: bakes NODE_ENV=production into the
        // pre-bundled deps so react/react-dom resolve to their cjs/*.production
        // builds. Scoped to the dep optimizer only — does NOT touch Vite's
        // react-refresh runtime (which must stay dev to keep HMR functional).
        ...(useReactProdInDev
          ? { rolldownOptions: { transform: { define: { 'process.env.NODE_ENV': '"production"' } } } }
          : {})
      }
    }
  }
})
