import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

const root = resolve(__dirname, '../../..')

/**
 * Throws at build/dev-server resolve time on any import path that only makes
 * sense under the Chromium fork's `chrome://` mojo IPC:
 *   - `@slayzone/mojo-bindings*` (the generated bindings package)
 *   - `//resources/mojo/*` (mojom-generated files' own import of the WebUI
 *     JS bindings runtime — Vite otherwise leaves this EXTERNAL, since it
 *     looks like a protocol-relative URL, and it 404s at runtime under
 *     `http://` with no build-time signal at all)
 *   - `@slayzone/window-api-shim/src/transport/mojo` (the shim's own mojo
 *     transport)
 *
 * Nothing in this shell's own tree imports any of these today — `renderer-app`
 * (the shared tree this shell mounts) never imports mojo-bindings or
 * window-api-shim at all (verified: only `chromium-shell` and
 * `window-api-shim` itself reference `resources/mojo`). This plugin is a
 * belt-and-braces build-time assertion against that staying true, not a
 * currently-needed workaround — the post-build `grep` in the plan's
 * verification checklist is the second half of the same guarantee.
 */
function forbidMojo(): Plugin {
  const FORBIDDEN = [/^@slayzone\/mojo-bindings/, /^\/\/resources\/mojo\//, /transport\/mojo/]
  return {
    name: 'slayzone-forbid-mojo',
    enforce: 'pre',
    resolveId(source) {
      if (FORBIDDEN.some((re) => re.test(source))) {
        throw new Error(
          `[web-shell] forbidden mojo import "${source}" — the web shell is a real web page, ` +
            "never chrome://, so nothing here may depend on the Chromium fork's mojo bindings."
        )
      }
      return null
    }
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, '')
  return {
    // Hard requirement of the SPA fallback (server.ts's `handleWebAssets`
    // serves this bundle from the hub's own origin root, not a subpath) —
    // chromium-shell's `'./'` would break absolute-path asset URLs here.
    base: '/',
    plugins: [
      forbidMojo(),
      // Babel + React Compiler, same as the Electron app and the fork —
      // auto-memoization matters most on a phone.
      react({ babel: { plugins: ['babel-plugin-react-compiler'] } }),
      tailwindcss()
    ],
    // Load env from the monorepo root, same as chromium-shell/electron.vite —
    // only VITE_*-prefixed vars reach the client (Vite default envPrefix).
    envDir: root,
    define: {
      __SLAYZONE_PROFILE__: 'false',
      __DEV__: JSON.stringify(mode !== 'production'),
      __POSTHOG_API_KEY__: JSON.stringify(
        env.POSTHOG_DISABLED === '1'
          ? ''
          : (env.POSTHOG_API_KEY ?? 'phc_b66nL6IJ3JhzrOEh98Tdk857rRYuoqWMmQmWShSnstV')
      ),
      __POSTHOG_HOST__: JSON.stringify(env.POSTHOG_HOST ?? 'https://eu.i.posthog.com')
      // No __SLAYZONE_CHROMIUM_PROD__ — that define exists only for
      // window-api-shim's server-url.ts, which this shell does not import
      // (it has its own server-url.ts, same-origin-derived, no build-time
      // port selection needed at all).
    },
    resolve: {
      alias: {
        // The ONLY alias this shell needs. Deliberately NOT propagating
        // chromium-shell's `'@' → packages/renderer-app/src` — nothing in
        // renderer-app's own source uses a bare `@/...` import (verified:
        // its own tsconfig.json has no such alias either), so that entry in
        // the fork's config is a dead path this shell must not inherit.
        'convex/_generated': resolve(root, 'convex/_generated')
      }
    },
    build: {
      // Lands directly in the hub's own served-assets directory — no copy
      // step. packages/apps/hub/build.mjs writes only bin.cjs +
      // sidecar-build.json and never cleans dist/, so there is no ordering
      // constraint between building the hub and building this bundle.
      outDir: resolve(root, 'packages/apps/hub/dist/web'),
      emptyOutDir: true,
      assetsDir: 'assets',
      rollupOptions: {
        input: resolve(__dirname, 'index.html')
      }
    },
    server: {
      port: 51735,
      strictPort: true
      // Plain HMR (no chrome://-style host/port pinning, no `cors: true`):
      // this dev server is reached at plain http://localhost:51735, which
      // the hub's ws-origin guard already accepts on a loopback-bound,
      // non-supervised hub (the standalone dev-server shape).
    }
  }
})
