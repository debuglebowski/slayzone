/**
 * setupFiles for vitest.harness.config.ts: runs in every worker before each file, so
 * before any suite imports better-auth (it captures NODE_ENV at module load) and before
 * any suite spawns a bin with the inherited env. See `vitest-injected-env.ts`.
 *
 * Also isolates the file from the caller (caller-env.ts), so no suite — and no child it
 * spawns with `...process.env` — can reach the hub, relay or task of the terminal the
 * run was started from, the caller's home, or the shipped hub port block. The config
 * already did this in vitest's main process; repeated here so a worker is clean however
 * it was forked, and so each file gets its own empty home and, by its pool id, its own
 * hub port block: files run concurrently, and two sharing one would bind each other's
 * stand-in ports.
 */
import { isolateFromCaller } from './caller-env'
import { stripVitestInjectedEnv } from './vitest-injected-env'

stripVitestInjectedEnv(process.env)
const poolId = Number(process.env.VITEST_POOL_ID)
isolateFromCaller(process.env, Number.isInteger(poolId) ? { slot: poolId } : {})
