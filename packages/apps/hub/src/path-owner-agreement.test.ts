/**
 * G2: the owner policy (`@slayzone/api` access.ts: whose is this path?) and git
 * routing (`@slayzone/worktrees` gitTargetForPath: whose checkout is this?) read a
 * path with ONE normalizer. When they disagreed, a path routing sent to user A's task
 * was "nobody's" to the policy — hub-wide, so user B was let through. For every path
 * form the reviewer used, both must answer the same: A's, or nobody's.
 */
import { describe, expect, test } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { canAccess, invalidateAccessCache, resource } from '@slayzone/api'
import { gitTargetForPath } from '@slayzone/worktrees/hub'

const h = await createTestHarness()
const sql = (s: string, ...p: unknown[]): void => void h.db.prepare(s).run(...p)
const A = 'user-a'
const B = 'user-b'
const wt = '/home/a-agree/wt/feat'

sql(`INSERT INTO projects (id, name, color, owner_user_id) VALUES ('pA', 'A', '#000', ?)`, A)
sql(`INSERT INTO tasks (id, project_id, title, worktree_path) VALUES ('tA', 'pA', 'T', ?)`, wt)
// Two of A's Windows computers, one placement each (a UNC share; a drive path
// stored with `/`).
for (const [computer, root] of [
  ['cA1', '\\\\srv\\share\\a-wt'],
  ['cA2', 'C:/code/a']
]) {
  sql(
    `INSERT INTO computers (id, name, platform, version, capabilities_json, created_at, owner_user_id)
     VALUES (?, ?, 'win32', '1', '[]', 1, ?)`,
    computer,
    computer,
    A
  )
  sql(
    `INSERT INTO project_placements (computer_id, project_id, root_path, status, updated_at)
     VALUES (?, 'pA', ?, 'ready', 1)`,
    computer,
    root
  )
}

/** Routing: does this path go to A's task or project? */
const routesToA = async (p: string): Promise<boolean> => {
  const t = await gitTargetForPath(h.slayDb, p)
  return t?.taskId === 'tA' || t?.projectId === 'pA'
}
/** Policy: is this path A's (B refused)? */
const policySaysA = async (p: string): Promise<boolean> => {
  invalidateAccessCache()
  const req = { authRequired: true, principal: { userId: B }, hubRoots: [] }
  return !(await canAccess(h.slayDb, req, resource('path', p)))
}

describe('routing and the owner policy agree on whose a path is', () => {
  for (const [p, owned] of [
    [wt, true],
    [`${wt}/x`, true],
    [`${wt}/sub/../x`, true],
    [`${wt}\\x`, false], // POSIX: a name beside the worktree, not inside it
    [`${wt}/../x`, false],
    ['\\\\srv\\share\\a-wt\\feat', true],
    ['\\\\srv\\share\\a-wt\\feat\\..\\..\\x', false], // UNC: `..` within the share
    ['C:\\code\\a\\src', true], // stored as C:/code/a
    ['C:\\code\\a-other', false]
  ] as const) {
    test(`${p} → ${owned ? "A's" : "nobody's"}`, async () => {
      expect(await routesToA(p), 'routing').toBe(owned)
      expect(await policySaysA(p), 'policy').toBe(owned)
    })
  }
})
