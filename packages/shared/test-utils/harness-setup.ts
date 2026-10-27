/**
 * setupFiles for vitest.harness.config.ts: runs in every worker before each file, so
 * before any suite imports better-auth (it captures NODE_ENV at module load) and before
 * any suite spawns a bin with the inherited env. See `vitest-injected-env.ts`.
 */
import { stripVitestInjectedEnv } from './vitest-injected-env'

stripVitestInjectedEnv(process.env)
