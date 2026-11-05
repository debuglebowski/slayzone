/**
 * Review regressions, hub owner check: reproductions from the pre-merge reviews of
 * feat/move-to-computer that decide WHOSE a path or a computer request is. Part of
 * the ONE review-regression suite (`pnpm test:review-regressions`,
 * packages/shared/test-utils/review-regressions.mjs); the earlier rounds' path forms
 * live in access.test, path-owner-agreement, git-op-owner-boundary and friends.
 *
 * Round 6 (artifact cfbc0854):
 *   L3 — the hub decided case folding for a COMPUTER's path by probing its own disk:
 *        on a macOS hub, `/home/u/proj` and `/home/u/PROJ` of two users on a Linux
 *        computer folded into one, and the tie let the other user in.
 *   L4 — a disabled computer still ran `exec.run` (automation shell and AI actions,
 *        conflict agents, probes) and created worktrees through `git.op`; routed
 *        background processes did not count as work running there.
 *   L6 — macOS aliases of a hub path (`/.vol/<dev>/<ino>`, the `/System/Volumes/Data`
 *        firmlink) and Windows aliases (`\\?\`, `\\localhost\C$`, trailing dots or
 *        spaces) reached the hub's database and other users' files.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { HubToComputerMethods as M } from '@slayzone/computer-transport/shared'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { canAccess, invalidateAccessCache, resource } from '@slayzone/api'
import { gitTargetForPath } from '@slayzone/worktrees/hub'
import { countRunningWork, startsNewWork } from './computer-new-work'

const h = await createTestHarness()
const sql = (s: string, ...p: unknown[]): void => void h.db.prepare(s).run(...p)
const A = 'user-a'
const B = 'user-b'

const base = realpathSync(mkdtempSync(join(tmpdir(), 'rr-owner-')))
const hubRoot = join(base, 'hub-root')
const hubDb = join(hubRoot, 'slayzone.data.sqlite')
const aLocal = join(base, 'a-local')
const aEnv = join(aLocal, '.env')
mkdirSync(hubRoot, { recursive: true })
mkdirSync(aLocal, { recursive: true })
writeFileSync(hubDb, 'db')
writeFileSync(aEnv, 'SECRET=1')

const project = (id: string, owner: string, path: string) =>
  sql(
    `INSERT INTO projects (id, name, color, owner_user_id, path) VALUES (?, ?, '#000', ?, ?)`,
    id,
    id,
    owner,
    path
  )
// L3: two users' roots that differ only in letter case, on a (case-sensitive) Linux
// computer; and one user's root nested in another's case variant.
project('pA', A, '/home/u/proj')
project('pB', B, '/home/u/PROJ')
project('pA2', A, '/home/u/sub/x')
project('pB2', B, '/home/u/Sub')
// L6: A's project on the hub's own disk.
project('pAlocal', A, aLocal)
// L3 routing: A's task worktree; B asks about a case variant of it.
sql(
  `INSERT INTO tasks (id, project_id, title, worktree_path) VALUES ('tA', 'pA', 'T', ?)`,
  '/Users/a/proj'
)
// L6 (Windows computer): A's project on drive C.
project('pAwin', A, 'C:\\Users\\a\\proj')

const can = async (user: string, path: string): Promise<boolean> => {
  invalidateAccessCache()
  return canAccess(
    h.slayDb,
    { authRequired: true, principal: { userId: user }, hubRoots: [hubRoot] },
    resource('path', path)
  )
}

describe("L3: case folding is the computer's, never the hub's disk", () => {
  test('a case-variant root of another user is no tie that lets them in', async () => {
    expect(await can(B, '/home/u/proj/.env')).toBe(false)
    expect(await can(A, '/home/u/proj/.env')).toBe(true)
    expect(await can(B, '/home/u/PROJ/.env')).toBe(true)
    expect(await can(A, '/home/u/PROJ/.env')).toBe(false)
  })

  test("a user's own folder is theirs, whatever a case variant nested in it", async () => {
    expect(await can(B, '/home/u/Sub/x/f')).toBe(true)
    expect(await can(A, '/home/u/Sub/x/f')).toBe(false)
    expect(await can(A, '/home/u/sub/x/f')).toBe(true)
  })

  test("routing: a case variant of A's worktree is not A's checkout", async () => {
    expect(await gitTargetForPath(h.slayDb, '/Users/a/proj/x')).toEqual({ taskId: 'tA' })
    expect(await gitTargetForPath(h.slayDb, '/Users/a/PROJ/x')).not.toEqual({ taskId: 'tA' })
  })
})

test("L3: one folder recorded for two users is neither's by path (a tie never grants)", async () => {
  project('pTieA', A, '/srv/same')
  project('pTieB', B, '/srv/same')
  expect(await can(A, '/srv/same/x')).toBe(false)
  expect(await can(B, '/srv/same/x')).toBe(false)
  sql(`DELETE FROM projects WHERE id IN ('pTieA', 'pTieB')`)
})

describe('L4: a disabled computer refuses exec.run and new worktrees', () => {
  test('exec.run starts new work', () => {
    expect(startsNewWork(M.execRun, { argv: ['claude', '-p', 'x'], timeoutMs: 1000 })).toBe(true)
  })

  test('git.op that creates a worktree or runs its setup is new work; other git ops are not', () => {
    expect(startsNewWork(M.gitOp, { op: 'addWorktree', input: {}, mutates: true })).toBe(true)
    expect(startsNewWork(M.gitOp, { op: 'runWorktreeSetupScript', input: {}, mutates: true })).toBe(
      true
    )
    expect(startsNewWork(M.gitOp, { op: 'copyIgnoredFiles', input: {}, mutates: true })).toBe(true)
    expect(startsNewWork(M.gitOp, { op: 'commitFiles', input: {}, mutates: true })).toBe(false)
    expect(startsNewWork(M.gitOp, { op: 'getStatusSummary', input: {}, mutates: false })).toBe(
      false
    )
  })

  test('a routed background process counts as work running on its computer', async () => {
    const gateway = {
      listComputers: () => [{ computerId: 'c1' }],
      request: async <T>(_id: string, method: string): Promise<T> => {
        if (method === M.ptyList) return { sessions: [] } as T
        if (method === M.ptyWarmList) return { warms: [] } as T
        if (method === M.chatRequest) return [] as T
        if (method === M.procList) return { sessions: [{ sessionId: 'proc-1', seq: 0 }] } as T
        throw new Error(`unexpected ${method}`)
      }
    }
    expect(await countRunningWork(gateway, 'c1')).toBe(1)
  })
})

describe('L6: hub path aliases resolve to the file they name before the owner check', () => {
  const vol = (p: string): string => {
    const st = statSync(p)
    return `/.vol/${st.dev}/${st.ino}`
  }

  test.skipIf(process.platform !== 'darwin')(
    '/.vol/<dev>/<ino> never reads the hub DB or a user file',
    async () => {
      expect(await can(A, vol(hubDb))).toBe(false)
      expect(await can(B, vol(hubDb))).toBe(false)
      expect(await can(B, vol(aEnv))).toBe(false)
      expect(await can(B, `${vol(aLocal)}/.env`)).toBe(false)
    }
  )

  test.skipIf(process.platform !== 'darwin')(
    'the /System/Volumes/Data firmlink is the same path',
    async () => {
      const firm = (p: string) => `/System/Volumes/Data${p}`
      expect(await can(A, firm(hubDb))).toBe(false)
      expect(await can(B, firm(hubDb))).toBe(false)
      expect(await can(B, firm(aEnv))).toBe(false)
      expect(await can(A, firm(aEnv))).toBe(true)
    }
  )

  test("Windows aliases of a computer's path are that path", async () => {
    expect(await can(B, 'C:\\Users\\a\\proj\\x')).toBe(false)
    for (const alias of [
      '\\\\?\\C:\\Users\\a\\proj\\x',
      '\\\\.\\C:\\Users\\a\\proj\\x',
      '\\\\localhost\\C$\\Users\\a\\proj\\x',
      '\\\\127.0.0.1\\c$\\Users\\a\\proj\\x',
      'C:\\Users\\a\\proj.\\x',
      'C:\\Users\\a\\proj \\x',
      'C:\\Users\\a\\proj. .\\x'
    ]) {
      expect(await can(B, alias), alias).toBe(false)
      expect(await can(A, alias), alias).toBe(true)
    }
  })
})

afterAll(() => {
  h.cleanup()
  rmSync(base, { recursive: true, force: true })
})
