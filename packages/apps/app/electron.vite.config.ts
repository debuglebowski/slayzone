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

  // In dev, flip process.env.NODE_ENV to 'production' so React (and other
  // node_modules that branch on it) use their prod bundles — no StrictMode
  // double-invoke, no dev-only invariant checks, no warning overhead. Combined
  // with esbuild.jsxDev=false (emits jsx not jsxDEV) so everything points at
  // react/jsx-runtime rather than react/jsx-dev-runtime. import.meta.env.DEV
  // and __DEV__ stay true so HMR + app dev logic are unaffected.
  // SLAYZONE_REACT_DEV=1 opts out. SLAYZONE_PROFILE=1 also opts out — profiling
  // requires dev React internals.
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
      define: {
        __POSTHOG_API_KEY__: JSON.stringify(
          env.POSTHOG_DISABLED === '1'
            ? ''
            : (env.POSTHOG_API_KEY ?? 'phc_b66nL6IJ3JhzrOEh98Tdk857rRYuoqWMmQmWShSnstV')
        ),
        __POSTHOG_HOST__: JSON.stringify(env.POSTHOG_HOST ?? 'https://eu.i.posthog.com'),
        __DEV__: JSON.stringify(mode !== 'production'),
        __SLAYZONE_PROFILE__: JSON.stringify(env.SLAYZONE_PROFILE === '1'),
        // Flip process.env.NODE_ENV to 'production' in dev so React (and other
        // node_modules that gate on it) use their prod bundles — no StrictMode
        // double-invoke, no dev invariants, no warning paths. Your own source
        // uses __DEV__ / import.meta.env.DEV which remain true, so HMR and
        // dev-only app logic are unaffected. SLAYZONE_REACT_DEV=1 opts out.
        ...(useReactProdInDev ? { 'process.env.NODE_ENV': '"production"' } : {})
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
            : {}),
        }
      },
      // esbuild.jsxDev controls whether the automatic JSX transform emits
      // jsxDEV (→ react/jsx-dev-runtime) or jsx (→ react/jsx-runtime).
      // Vite defaults this to !isProduction; we override to false so the
      // transform always emits jsx — consistent with the prod React bundles
      // loaded via the NODE_ENV define. No carve-out for jsx-dev-runtime needed.
      ...(useReactProdInDev ? { esbuild: { jsxDev: false } } : {}),
      plugins: [
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
        // Vite's `define` above rewrites source files but NOT pre-bundled deps
        // in .vite/deps (those are processed by esbuild before Vite's transform
        // pipeline runs). Mirror the define here so pre-bundled node_modules
        // also pick their production branches.
        ...(useReactProdInDev
          ? { esbuildOptions: { define: { 'process.env.NODE_ENV': '"production"' } } }
          : {})
      }
    }
  }
})
