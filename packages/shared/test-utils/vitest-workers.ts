import { availableParallelism } from 'node:os'

/**
 * Every vitest config's `maxWorkers`: how many test workers ONE vitest run may keep busy.
 *
 * Agents run vitest directly (`npx vitest run src/client/chat` in a package), outside
 * `pnpm test:unit` and its machine-wide CI lock (scripts/ci-lock.mjs). With no cap that is
 * one worker per core minus one per run, and several agents at once pinned the machine.
 *
 *   SLZ_UNIT_WORKERS=<n>     n.
 *   SLZ_UNIT_WORKERS=all     `configured` (undefined: vitest's own default) — `pnpm test:unit:fast`.
 *   CI set                   `configured`: a CI runner runs nothing else.
 *   otherwise                half the cores (min 2), or `configured` when that is lower.
 *
 * `pnpm test:unit` passes its own --maxWorkers (lane_workers in runners.sh), which wins
 * over this, so its lanes keep their split of the same half-the-cores budget.
 */
export function localMaxWorkers(
  configured?: number,
  env: NodeJS.ProcessEnv = process.env,
  cores: number = availableParallelism()
): number | undefined {
  const budget = env.SLZ_UNIT_WORKERS ?? ''
  if (budget === 'all') return configured
  if (budget !== '') {
    if (!/^[1-9][0-9]*$/.test(budget)) {
      throw new Error(`SLZ_UNIT_WORKERS: '${budget}' is not a positive integer or 'all'`)
    }
    return Number(budget)
  }
  if (env.CI && env.CI !== 'false' && env.CI !== '0') return configured
  const half = Math.max(2, Math.floor(cores / 2))
  return configured === undefined ? half : Math.min(configured, half)
}
