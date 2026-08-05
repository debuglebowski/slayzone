import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

/**
 * This package is the one place where BOTH test styles live side by side in `src/`:
 *
 *   - real vitest suites (`import { describe, it } from 'vitest'`), run by `pnpm test`
 *     — which CI's `check-windows` job invokes as the "shell primitives" step;
 *   - hand-rolled tsx harness scripts that `console.log` + `process.exit()`, listed by
 *     explicit path in `packages/shared/test-utils/run-all.sh` and run under `npx tsx`.
 *
 * Repo-wide, both styles are named `*.test.ts`, so vitest's default glob sweeps the
 * harness scripts too and fails every one of them — "No test suite found in file" for
 * the ones that register nothing, "process.exit unexpectedly called" for the ones that
 * reach their own exit line. They are already covered by `run-all.sh`, so keeping them
 * out of vitest loses no coverage; it only drops the double-registration.
 *
 * Classify by what each file IS rather than hardcoding a list: a list is exactly what
 * rotted here. The CI step was added when `shell.test.ts` was the only file it matched,
 * and the nine harness scripts that landed afterwards each silently widened its glob.
 * Reading the import keeps a tenth from doing the same.
 */
const srcDir = fileURLToPath(new URL('src', import.meta.url))
const harnessScripts = readdirSync(srcDir)
  .filter((file) => file.endsWith('.test.ts'))
  .filter((file) => !/from\s+['"]vitest['"]/.test(readFileSync(`${srcDir}/${file}`, 'utf8')))
  .map((file) => `src/${file}`)

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ...harnessScripts],
  },
})
