import { app } from 'electron'
import { overrideNodeEnv } from '@slayzone/platform/env-manifest'

/**
 * Imported by bootstrap.ts before index.ts loads, so it runs before any other
 * main-process module: the packaged app is production, whatever the launching shell
 * exported. Libraries read the real variable at runtime (tRPC's `isDev`,
 * electron-chrome-web-store's update checks), so a build-time define cannot reach
 * them. The sidecar hub inherits it; user terminals and processes get the launcher's
 * value back (overrideNodeEnv records it, sanitizeSpawnEnv restores it). Unpackaged
 * runs (dev, e2e) keep the launcher's value.
 */
if (app.isPackaged) overrideNodeEnv(process.env, 'production')
