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
import { canAccess, invalidateAccessCache, requestComputerOf, resource } from '@slayzone/api'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
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
// L3 routing: A's task worktree and B's at a case variant of it.
const task = (id: string, projectId: string, worktree: string) =>
  sql(
    `INSERT INTO tasks (id, project_id, title, worktree_path) VALUES (?, ?, 'T', ?)`,
    id,
    projectId,
    worktree
  )
task('tA', 'pA', '/Users/a/proj')
task('tB', 'pB', '/Users/a/PROJ')
// N6: one worktree only (a macOS path spelled in another case finds it), and two
// that differ only in case (no guess between them).
task('tC', 'pA', '/Users/c/Proj')
task('tD', 'pA', '/Users/d/x')
task('tE', 'pB', '/Users/d/X')
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
    expect(await gitTargetForPath(h.slayDb, '/Users/a/PROJ/x')).toEqual({ taskId: 'tB' })
  })
})

// Round-7 N6: exact-case routing alone sent `/Users/c/proj/x` (a worktree recorded as
// `/Users/c/Proj`, on a case-insensitive Mac) to the caller's default computer. An
// exact match still wins; with none, ONE case-insensitive candidate is taken (the
// gateway's owner check still decides whether the caller may use it); two are not
// guessed between.
describe('N6: git routing falls back to a single case-insensitive candidate', () => {
  test('one candidate in another case: that task', async () => {
    expect(await gitTargetForPath(h.slayDb, '/Users/c/proj/sub')).toEqual({ taskId: 'tC' })
  })
  test('two candidates differing only in case: neither', async () => {
    const t = await gitTargetForPath(h.slayDb, '/Users/D/x/f')
    expect(t?.taskId).toBeUndefined()
  })
  test('an exact match still wins over case variants', async () => {
    expect(await gitTargetForPath(h.slayDb, '/Users/d/X/f')).toEqual({ taskId: 'tE' })
  })
})

test("L3: one folder recorded for two users is neither's by path (a tie never grants)", async () => {
  project('pTieA', A, '/srv/same')
  project('pTieB', B, '/srv/same')
  expect(await can(A, '/srv/same/x')).toBe(false)
  expect(await can(B, '/srv/same/x')).toBe(false)
  sql(`DELETE FROM projects WHERE id IN ('pTieA', 'pTieB')`)
})

// Round-7 N4: since L3 a tie denies both — so user A could lock user B out of B's own
// folder by registering a project at B's root on A's computer. A request that names
// its computer breaks the tie: the root recorded on THAT computer decides (the
// gateway then refuses a computer the caller does not own). With no computer named,
// or none of the tied roots on it, the tie still denies — and says so in the audit log.
describe('N4: a tie is broken by the computer the request names', () => {
  const computerOf = (id: string, owner: string) =>
    sql(
      `INSERT INTO computers (id, name, platform, version, capabilities_json, created_at, owner_user_id)
       VALUES (?, ?, 'linux-x64', '1', '[]', 1, ?)`,
      id,
      id,
      owner
    )
  computerOf('cTieA', A)
  computerOf('cTieB', B)
  const placed = (computerId: string, projectId: string, root: string) =>
    sql(
      `INSERT INTO project_placements (computer_id, project_id, root_path, status, updated_at)
       VALUES (?, ?, ?, 'ready', 1)`,
      computerId,
      projectId,
      root
    )
  project('pN4A', A, '/srv/n4')
  project('pN4B', B, '/srv/n4')
  sql(`UPDATE projects SET path = NULL WHERE id IN ('pN4A', 'pN4B')`)
  placed('cTieB', 'pN4B', '/srv/n4')
  placed('cTieA', 'pN4A', '/srv/n4')
  const canOn = async (user: string, path: string, computerId?: string) => {
    invalidateAccessCache()
    return canAccess(
      h.slayDb,
      {
        authRequired: true,
        principal: { userId: user },
        hubRoots: [hubRoot],
        ...(computerId ? { computerId } : {})
      },
      resource('path', path)
    )
  }

  test("B's request on B's computer: B's folder", async () => {
    expect(await canOn(B, '/srv/n4/x', 'cTieB')).toBe(true)
    expect(await canOn(A, '/srv/n4/x', 'cTieB')).toBe(false)
  })
  test("A's request on A's computer: A's folder", async () => {
    expect(await canOn(A, '/srv/n4/x', 'cTieA')).toBe(true)
    expect(await canOn(B, '/srv/n4/x', 'cTieA')).toBe(false)
  })
  test('no computer named: the tie denies both, and is audited', async () => {
    const lines: Array<Record<string, unknown>> = []
    setSecurityLogSink((line) => lines.push(JSON.parse(line) as Record<string, unknown>))
    try {
      expect(await canOn(B, '/srv/n4/x')).toBe(false)
      expect(await canOn(A, '/srv/n4/x')).toBe(false)
    } finally {
      setSecurityLogSink()
    }
    const ties = lines.filter((l) => l.event === 'authz.path_tie')
    expect(ties).toHaveLength(2)
    // A path can carry a user's directory names: never logged.
    expect(JSON.stringify(ties)).not.toContain('/srv/n4')
  })
  // Round-9 Q2: a project from before v176 keeps its legacy `projects.path` next to its
  // placement. Counted as one more (computer-less) owner, it made every tie
  // "unbreakable": B's computer reporting A's folder locked A out on A's own computer.
  test("Q2: a legacy project path does not lock its owner out on the owner's computer", async () => {
    project('pQ2A', A, '/srv/q2')
    project('pQ2B', B, '/srv/q2-b')
    sql(`UPDATE projects SET path = NULL WHERE id = 'pQ2B'`)
    placed('cTieA', 'pQ2A', '/srv/q2')
    placed('cTieB', 'pQ2B', '/srv/q2')
    expect(await canOn(A, '/srv/q2/x', 'cTieA')).toBe(true)
    expect(await canOn(B, '/srv/q2/x', 'cTieB')).toBe(true)
    expect(await canOn(B, '/srv/q2/x', 'cTieA')).toBe(false)
  })
  test('the gate reads the computer a request names', () => {
    expect(requestComputerOf({ target: { computerId: 'c1' }, path: '/x' })).toBe('c1')
    expect(requestComputerOf({ computerId: 'c2' })).toBe('c2')
    expect(requestComputerOf({ path: '/x' })).toBeNull()
    expect(requestComputerOf(undefined)).toBeNull()
  })
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

// ── final review: owner resolution ────────────────────────────────────────────

const computerOf = (id: string, owner: string) =>
  sql(
    `INSERT OR IGNORE INTO computers (id, name, platform, version, capabilities_json, created_at, owner_user_id)
     VALUES (?, ?, 'linux-x64', '1', '[]', 1, ?)`,
    id,
    id,
    owner
  )
const placeAt = (computerId: string, projectId: string, folder: string) =>
  sql(
    `INSERT INTO project_placements (computer_id, project_id, root_path, status, updated_at)
     VALUES (?, ?, ?, 'ready', 1)`,
    computerId,
    projectId,
    folder
  )
const decide = async (
  user: string,
  kind: 'path' | 'ownedPath',
  path: string,
  computerId?: string
): Promise<boolean> => {
  invalidateAccessCache()
  return canAccess(
    h.slayDb,
    {
      authRequired: true,
      principal: { userId: user },
      hubRoots: [hubRoot],
      ...(computerId ? { computerId } : {})
    },
    resource(kind, path)
  )
}
computerOf('cM8A', A)
computerOf('cM8B', B)

describe('M8: owner resolution gaps (final review)', () => {
  test("a stale legacy path of B's never locks A out — with no computer named", async () => {
    project('pM8B', B, '/srv/m8') // B's old path, before v176
    placeAt('cM8B', 'pM8B', '/srv/m8-elsewhere') // B's project lives elsewhere now
    project('pM8A', A, '/srv/m8')
    sql(`UPDATE projects SET path = NULL WHERE id = 'pM8A'`)
    placeAt('cM8A', 'pM8A', '/srv/m8')
    expect(await decide(A, 'path', '/srv/m8/x')).toBe(true)
    expect(await decide(B, 'path', '/srv/m8/x')).toBe(false)
  })

  test("on the hub's disk, a stale legacy path of a project placed elsewhere is no root", async () => {
    const stale = join(base, 'm8-stale')
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'f.txt'), 'x')
    project('pM8Bstale', B, stale)
    placeAt('cM8B', 'pM8Bstale', '/srv/m8-b-now')
    expect(await decide(B, 'ownedPath', join(stale, 'f.txt'))).toBe(false)
  })

  test.skipIf(process.platform !== 'darwin')(
    "a longer spelling of the hub's own folder (a firmlink) does not outrank it",
    async () => {
      project('pM8firm', A, `/System/Volumes/Data${hubRoot}`)
      expect(await decide(A, 'ownedPath', hubDb)).toBe(false)
      expect(await decide(A, 'path', hubDb)).toBe(false)
    }
  )
})

afterAll(() => {
  h.cleanup()
  rmSync(base, { recursive: true, force: true })
})
