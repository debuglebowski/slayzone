// Minimal `import.meta.env` typing so this package's tsgo build understands the
// build-time `VITE_CONVEX_URL` define. The consuming app's Vite (Electron or the
// chromium-shell fork) statically inlines `import.meta.env.VITE_CONVEX_URL`.
interface ImportMetaEnv {
  readonly VITE_CONVEX_URL?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
