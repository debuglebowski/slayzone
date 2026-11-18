import { isolateFromCaller } from './packages/shared/test-utils/caller-env.ts'
import { localMaxWorkers } from './packages/shared/test-utils/vitest-workers.ts'

// Only for a vitest run started in this directory (`npx vitest run <path>`): `pnpm test:unit`
// runs these files under run-all.sh's configs. No suite inherits the caller's SlayZone wiring,
// home or hub port block (see caller-env.ts), and one run keeps at most half the cores busy
// (vitest-workers.ts). Other worktrees' copies of the tests are not collected.
isolateFromCaller()

export default {
  test: {
    exclude: ['**/node_modules/**', '**/.git/**', '**/.claude/worktrees/**'],
    maxWorkers: localMaxWorkers()
  }
}
