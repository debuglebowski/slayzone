/**
 * Review regressions, the hub's own disk (round 8): reproductions of reads a user
 * must never get from a hub with login. Part of the ONE review-regression suite
 * (`pnpm test:review-regressions`). Through the real `appRouter` with login on, so
 * the owner gate runs exactly as on the hub.
 *
 *   P2 — since N4, naming a computer broke a path tie: user A recorded B's folder as
 *        a placement on A's own computer, named that computer, and read B's file off
 *        the HUB's disk. The named computer says nothing about the hub's disk: a tie
 *        there denies; and a root with no computer (the hub's own, legacy) never
 *        loses a tie because a computer was named.
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { setAuthGate } from '@slayzone/trpc-server'
import { describe, expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { canAccess, invalidateAccessCache, resource } from '../access'
import { appRouter } from '../router.js'

const h = await createTestHarness()
const sql = (s: string, ...p: unknown[]): void => void h.db.prepare(s).run(...p)
setSecurityLogSink(() => undefined)
setAuthGate(() => true)

const base = realpathSync(mkdtempSync(join(tmpdir(), 'slz-rr-hubdisk-')))
const hubRoot = join(base, 'hub-root')
const aRoot = join(base, 'a-proj')
const bRoot = join(base, 'b-proj')
for (const d of [hubRoot, aRoot, bRoot]) mkdirSync(d, { recursive: true })
writeFileSync(join(hubRoot, 'slayzone.data.sqlite'), 'HUB-DATABASE')
writeFileSync(join(bRoot, 'secret.txt'), 'B-SECRET')
writeFileSync(join(aRoot, 'README.md'), 'A-OWN')
process.env.SLAYZONE_ROOT = hubRoot

const A = 'user-a'
const B = 'user-b'
sql(
  `INSERT INTO projects (id, name, color, owner_user_id, path) VALUES
  ('pA', 'A', '#111', ?, ?), ('pB', 'B', '#222', ?, ?)`,
  A,
  aRoot,
  B,
  bRoot
)
sql(`INSERT INTO tasks (id, project_id, title) VALUES ('tA', 'pA', 'a'), ('tB', 'pB', 'b')`)
sql(
  `INSERT INTO computers (id, name, platform, version, capabilities_json, created_at, owner_user_id)
   VALUES ('cA', 'a', 'darwin', '1', '[]', 1, ?), ('cB', 'b', 'darwin', '1', '[]', 1, ?)`,
  A,
  B
)
// A reports B's folder as one of A's project folders on A's own computer: the hub
// does not check the paths a computer reports, so this is A's to create.
sql(
  `INSERT INTO project_placements (computer_id, project_id, root_path, status, updated_at)
   VALUES ('cA', 'pA', ?, 'ready', 1)`,
  bRoot
)

const as = (userId: string) =>
  appRouter.createCaller({
    db: h.slayDb,
    dataRoot: hubRoot,
    principal: { userId, role: 'user' as const, scopes: ['full' as const] }
  })

async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'ok'
  } catch (e) {
    return (e as { code?: string }).code === 'NOT_FOUND' ? 'NOT_FOUND' : String(e)
  }
}

describe('P2: naming a computer never wins a tie on the hub’s disk', () => {
  const secret = join(bRoot, 'secret.txt')

  test('A uploading B’s file: refused with and without a computer named', async () => {
    const a = as(A)
    expect(await outcome(a.artifacts.upload({ taskId: 'tA', sourcePath: secret }))).toBe(
      'NOT_FOUND'
    )
    for (const named of [{ computerId: 'cA' }, { target: { computerId: 'cA' } }]) {
      const call = a.artifacts.upload({ taskId: 'tA', sourcePath: secret, ...named } as never)
      expect(await outcome(call), JSON.stringify(named)).toBe('NOT_FOUND')
    }
    const art = await a.artifacts.upload({ taskId: 'tA', sourcePath: join(aRoot, 'README.md') })
    expect(await a.artifacts.readContent({ id: art!.id })).toBe('A-OWN')
  })

  test('A uploading B’s folder: refused with a computer named', async () => {
    const call = as(A).artifacts.uploadDir({
      taskId: 'tA',
      dirPath: bRoot,
      computerId: 'cA'
    } as never)
    expect(await outcome(call)).toBe('NOT_FOUND')
  })

  const decide = (user: string, kind: 'path' | 'ownedPath' | 'pathTree', computerId: string) => {
    invalidateAccessCache()
    return canAccess(
      h.slayDb,
      { authRequired: true, principal: { userId: user }, hubRoots: [hubRoot], computerId },
      resource(kind, kind === 'pathTree' ? bRoot : secret)
    )
  }

  test('hub-disk kinds: a tie denies whatever computer is named', async () => {
    for (const kind of ['ownedPath', 'pathTree'] as const) {
      expect(await decide(A, kind, 'cA'), `${kind} A on cA`).toBe(false)
      expect(await decide(B, kind, 'cB'), `${kind} B on cB`).toBe(false)
    }
  })

  test('a root with no computer (the hub’s own) never loses a tie to a named computer', async () => {
    expect(await decide(A, 'path', 'cA')).toBe(false)
  })
})
