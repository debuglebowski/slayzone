import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

const root = resolve(__dirname, '../../..')

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Load env from the monorepo root (mirrors the Electron renderer's
  // electron.vite.config `envDir: root`) so the fork bundle picks up
  // VITE_CONVEX_URL from the root .env — the lever that flips the leaderboard's
  // ConvexAuthBootstrap from disabled to wired. Only VITE_*-prefixed vars are
  // exposed to the client (Vite default envPrefix), so root-only secrets stay out.
  envDir: root,
  // cap-shell-1 — the renderer-app tree references compile-time globals that
  // Electron's vite config defines. The shell mirrors the subset needed at
  // module eval so the bundle loads cleanly; runtime window.api calls still
  // hit the Proxy stub (cap-shell-2 replaces that).
  define: {
    __SLAYZONE_PROFILE__: 'false',
    __DEV__: 'false',
    __POSTHOG_API_KEY__: JSON.stringify(''),
    __POSTHOG_HOST__: JSON.stringify(''),
    // Selects the renderer's baked-in default sidecar WS URL (dev :8766 vs
    // prod :8765) when no --slayzone-server-url override is injected. The
    // dogfood build (`pnpm build:chromium`) leaves it false → dev port; the
    // packaging pipeline sets SLAYZONE_CHROMIUM_PROD=1 → prod port. Dev/prod
    // differ so a dev build + packaged app can run side-by-side. See
    // window-api-shim/src/server-url.ts.
    __SLAYZONE_CHROMIUM_PROD__: JSON.stringify(process.env.SLAYZONE_CHROMIUM_PROD === '1')
  },
  resolve: {
    alias: {
      // cap-shell-1 — renderer-app's source uses `@/components/*` etc. Point
      // the shell's Vite alias at the same location so those imports resolve
      // when the shell bundle pulls renderer-app via the workspace dep.
      '@': resolve(root, 'packages/renderer-app/src'),
      'convex/_generated': resolve(root, 'convex/_generated')
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // chrome:// serves bundle assets under /assets/ at the same origin; keep
    // relative so the bundle is location-agnostic (dev Vite server + the
    // served chrome:// host both resolve fine).
    assetsDir: 'assets',
    rollupOptions: {
      input: resolve(__dirname, 'index.html')
    }
  },
  base: './',
  server: {
    // cap-shell-dx-hmr — when the Chromium fork proxies chrome://slayzone-shell/
    // to this dev server, the page is served on chrome:// origin. Vite's HMR
    // client otherwise auto-derives ws://<location.host>/ which yields
    // ws://slayzone-shell/ (invalid). Pin the HMR endpoint explicitly so the
    // client always opens ws://localhost:5173.
    hmr: {
      protocol: 'ws',
      host: 'localhost',
      port: 5173,
      clientPort: 5173,
    },
    // Vite needs CORS for the chrome:// origin to fetch modules.
    cors: true,
  },
})
