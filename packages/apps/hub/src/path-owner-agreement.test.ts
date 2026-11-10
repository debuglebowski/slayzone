/**
 * G2: the owner policy (`@slayzone/api` access.ts: whose is this path?) reads a path
 * with ONE normalizer. Routing by path is gone (§9 Phase 7c: every path request names
 * its task / project scope and the computer confines the path), so only the policy's
 * answer remains to pin: for every path form the reviewer used, A's or nobody's.
 *
 * The hub keeps no task folder (§9 7e): a worktree path is nobody's here (the
 * computer confines it to its task); the spellings are pinned on A's placement roots.
 */
import { describe, expect, test } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { canAccess, invalidateAccessCache, resource } from '@slayzone/api'

const h = await createTestHarness()
const sql = (s: string, ...p: unknown[]): void => void h.db.prepare(s).run(...p)
const A = 'user-a'
const B = 'user-b'
const wt = '/home/a-agree/wt/feat'
const root = '/home/a-agree/proj'

sql(`INSERT INTO projects (id, name, color, owner_user_id) VALUES ('pA', 'A', '#000', ?)`, A)
sql(`INSERT INTO tasks (id, project_id, title, has_worktree) VALUES ('tA', 'pA', 'T', 1)`)
// A's computers, one placement each: POSIX, a UNC share, a drive path stored with `/`.
for (const [computer, root, platform] of [
  ['cA0', '/home/a-agree/proj', 'linux'],
  ['cA1', '\\\\srv\\share\\a-wt', 'win32'],
  ['cA2', 'C:/code/a', 'win32']
]) {
  sql(
    `INSERT INTO computers (id, name, platform, version, capabilities_json, created_at, owner_user_id)
     VALUES (?, ?, ?, '1', '[]', 1, ?)`,
    computer,
    computer,
    platform,
    A
  )
  sql(
    `INSERT INTO project_placements (computer_id, project_id, root_path, status, updated_at)
     VALUES (?, 'pA', ?, 'ready', 1)`,
    computer,
    root
  )
}

/** Policy: is this path A's (B refused)? */
const policySaysA = async (p: string): Promise<boolean> => {
  invalidateAccessCache()
  const req = { authRequired: true, principal: { userId: B }, hubRoots: [] }
  return !(await canAccess(h.slayDb, req, resource('path', p)))
}

describe('the owner policy decides whose a path is, in every spelling', () => {
  for (const [p, owned] of [
    [root, true],
    [`${root}/x`, true],
    [`${root}/sub/../x`, true],
    [`/${root}/x`, true], // K1: a leading `//` is the same path on POSIX, never UNC
    [`//${root}`, true],
    [`${root}\\x`, false], // POSIX: a name beside the root, not inside it
    [`${root}/../x`, false],
    [wt, false], // a task's worktree: no hub record (§9 7e), the computer confines it
    [`${wt}/x`, false],
    ['\\\\srv\\share\\a-wt\\feat', true],
    ['\\\\srv\\share\\a-wt\\feat\\..\\..\\x', false], // UNC: `..` within the share
    ['C:\\code\\a\\src', true], // stored as C:/code/a
    ['C:\\code\\a-other', false]
  ] as const) {
    test(`${p} → ${owned ? "A's" : "nobody's"}`, async () => {
      expect(await policySaysA(p), 'policy').toBe(owned)
    })
  }
})
