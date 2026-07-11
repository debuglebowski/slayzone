/**
 * WorktreePolicyOps resolver tests — project-override → global-setting → default
 * precedence for both resolvers, plus the pre-v70 stale-column fallback and the
 * legacy delegate signatures. Uses a fake db (no sqlite, no electron).
 *
 * Run with: pnpm exec vitest run --config packages/apps/app/vitest.config.ts \
 *   packages/domains/worktrees/src/server/composite-ops.test.ts
 */
import { describe, it, expect } from 'vitest'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  createDbWorktreePolicyOps,
  resolveCopyBehavior,
  resolveSubmoduleInitBehavior
} from './composite-ops'

type ProjectRow = Record<string, string | null>

/** The project id every test binds — the fake only matches rows against it. */
const PROJECT_ID = 'p1'

/**
 * Fake `SlayzoneDb` covering exactly the surface the resolvers use:
 * `prepare(sql).get(...)` against `projects` and `settings`. The projects
 * lookup honors the bound id param (returns no row on a mismatched or missing
 * bind), so a resolver that stops passing `projectId` fails the override tests.
 */
function makeFakeDb(opts: {
  /** Row returned for `SELECT ... FROM projects WHERE id = PROJECT_ID` (undefined = no row). */
  projectRow?: ProjectRow
  /** Simulate a pre-v70 DB: any projects query throws (missing column). */
  projectsThrow?: boolean
  /** key → value rows for `SELECT value FROM settings WHERE key = '...'`. */
  settings?: Record<string, string>
}): SlayzoneDb {
  const fake = {
    prepare(sql: string) {
      return {
        async get(...params: unknown[]): Promise<unknown> {
          if (sql.includes('FROM projects')) {
            if (opts.projectsThrow) {
              throw new Error('no such column: worktree_copy_behavior')
            }
            return params[0] === PROJECT_ID ? opts.projectRow : undefined
          }
          if (sql.includes('FROM settings')) {
            const key = sql.match(/key = '([^']+)'/)?.[1]
            const value = key ? opts.settings?.[key] : undefined
            return value === undefined ? undefined : { value }
          }
          throw new Error(`unexpected SQL: ${sql}`)
        }
      }
    }
  }
  return fake as unknown as SlayzoneDb
}

describe('WorktreePolicyOps.resolveCopyBehavior', () => {
  it('project override wins over global setting', async () => {
    const ops = createDbWorktreePolicyOps(
      makeFakeDb({
        projectRow: { worktree_copy_behavior: 'all', worktree_copy_paths: null },
        settings: { worktree_copy_behavior: 'none' }
      })
    )
    expect(await ops.resolveCopyBehavior('p1')).toEqual({ behavior: 'all', customPaths: [] })
  })

  it('project override "custom" parses + trims its own paths', async () => {
    const ops = createDbWorktreePolicyOps(
      makeFakeDb({
        projectRow: { worktree_copy_behavior: 'custom', worktree_copy_paths: ' .env , dist ,,a' },
        settings: { worktree_copy_behavior: 'none', worktree_copy_paths: 'GLOBAL' }
      })
    )
    expect(await ops.resolveCopyBehavior('p1')).toEqual({
      behavior: 'custom',
      customPaths: ['.env', 'dist', 'a']
    })
  })

  it('null project override inherits the global setting', async () => {
    const ops = createDbWorktreePolicyOps(
      makeFakeDb({
        projectRow: { worktree_copy_behavior: null, worktree_copy_paths: null },
        settings: { worktree_copy_behavior: 'custom', worktree_copy_paths: 'x, y' }
      })
    )
    expect(await ops.resolveCopyBehavior('p1')).toEqual({
      behavior: 'custom',
      customPaths: ['x', 'y']
    })
  })

  it('no projectId reads the global setting', async () => {
    const ops = createDbWorktreePolicyOps(
      makeFakeDb({ settings: { worktree_copy_behavior: 'none' } })
    )
    expect(await ops.resolveCopyBehavior()).toEqual({ behavior: 'none', customPaths: [] })
  })

  it('defaults to "ask" when nothing is configured', async () => {
    const ops = createDbWorktreePolicyOps(makeFakeDb({}))
    expect(await ops.resolveCopyBehavior('p1')).toEqual({ behavior: 'ask', customPaths: [] })
  })

  it('pre-v70 DB (projects query throws) falls through to global setting', async () => {
    const ops = createDbWorktreePolicyOps(
      makeFakeDb({ projectsThrow: true, settings: { worktree_copy_behavior: 'all' } })
    )
    expect(await ops.resolveCopyBehavior('p1')).toEqual({ behavior: 'all', customPaths: [] })
  })
})

describe('WorktreePolicyOps.resolveSubmoduleInit', () => {
  it('project override wins over global setting', async () => {
    const ops = createDbWorktreePolicyOps(
      makeFakeDb({
        projectRow: { worktree_submodule_init: 'skip' },
        settings: { worktree_submodule_init: 'auto' }
      })
    )
    expect(await ops.resolveSubmoduleInit('p1')).toBe('skip')
  })

  it('null project override inherits the global setting', async () => {
    const ops = createDbWorktreePolicyOps(
      makeFakeDb({
        projectRow: { worktree_submodule_init: null },
        settings: { worktree_submodule_init: 'skip' }
      })
    )
    expect(await ops.resolveSubmoduleInit('p1')).toBe('skip')
  })

  it('defaults to "auto" when nothing is configured', async () => {
    const ops = createDbWorktreePolicyOps(makeFakeDb({}))
    expect(await ops.resolveSubmoduleInit('p1')).toBe('auto')
  })

  it('pre-v70 DB (projects query throws) falls through to global setting', async () => {
    const ops = createDbWorktreePolicyOps(
      makeFakeDb({ projectsThrow: true, settings: { worktree_submodule_init: 'skip' } })
    )
    expect(await ops.resolveSubmoduleInit('p1')).toBe('skip')
  })
})

describe('legacy delegate signatures', () => {
  it('resolveCopyBehavior(db, projectId) matches the ops result', async () => {
    const db = makeFakeDb({
      projectRow: { worktree_copy_behavior: 'custom', worktree_copy_paths: 'a,b' },
      settings: { worktree_copy_behavior: 'none' }
    })
    expect(await resolveCopyBehavior(db, 'p1')).toEqual(
      await createDbWorktreePolicyOps(db).resolveCopyBehavior('p1')
    )
  })

  it('resolveSubmoduleInitBehavior(db, projectId) matches the ops result', async () => {
    const db = makeFakeDb({
      projectRow: { worktree_submodule_init: 'skip' },
      settings: { worktree_submodule_init: 'auto' }
    })
    expect(await resolveSubmoduleInitBehavior(db, 'p1')).toBe(
      await createDbWorktreePolicyOps(db).resolveSubmoduleInit('p1')
    )
  })
})
