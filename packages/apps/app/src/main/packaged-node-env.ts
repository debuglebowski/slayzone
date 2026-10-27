import { app } from 'electron'

/**
 * Imported by bootstrap.ts before index.ts loads, so it runs before any other
 * main-process module: the packaged app is production, whatever the launching shell
 * exported. Libraries read the real variable at runtime (tRPC's `isDev`,
 * electron-chrome-web-store's update checks), so a build-time define cannot reach
 * them. The sidecar hub inherits it; sanitizeSpawnEnv keeps it out of user terminals
 * and processes. Unpackaged runs (dev, e2e) keep the launcher's value.
 */
if (app.isPackaged) process.env.NODE_ENV = 'production'
