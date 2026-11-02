/**
 * setupFiles for vitest.harness.config.ts: runs in every worker before each file, so
 * before any suite imports better-auth (it captures NODE_ENV at module load) and before
 * any suite spawns a bin with the inherited env. See `vitest-injected-env.ts`.
 *
 * Also strips the caller's SlayZone wiring (caller-env.ts), so no suite — and no child
 * it spawns with `...process.env` — can reach the hub, relay or task of the terminal
 * the run was started from. The config already did this in vitest's main process;
 * repeated here so a worker is clean however it was forked.
 */
import { stripCallerSlayzoneEnv } from './caller-env'
import { stripVitestInjectedEnv } from './vitest-injected-env'

stripVitestInjectedEnv(process.env)
stripCallerSlayzoneEnv()
