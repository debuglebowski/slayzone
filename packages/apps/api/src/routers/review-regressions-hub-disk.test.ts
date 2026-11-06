/**
 * Review regressions, the hub's own disk (round 8): reproductions of reads a user
 * must never get from a hub with login. Part of the ONE review-regression suite
 * (`pnpm test:review-regressions`). Through the real `appRouter` with login on, so
 * the owner gate runs exactly as on the hub.
 *
 *   P2 — since N4, naming a computer broke a path tie: user A recorded B's folder as
 *        a placement on A's own computer, named that computer, and read B's file off
 *        the HUB's disk. The named computer says nothing about the hub's disk.
 *   Q1 — the cause underneath (round 9): what a REMOTE computer reports (its project
 *        folders) counted as owned folders on the hub's own disk. A's computer
 *        reporting `<B's folder>/secret.txt`, `<B's folder>/sub` or `/` gave A that
 *        file, B's files or `/etc/hosts`; reporting B's folder exactly locked B out.
 *        On the hub's disk, ownership comes only from records of the hub's disk:
 *        project paths, hub-side worktrees, the hub's own local computer.
 */
import * as fs from 'node:fs'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { setAuthGate } from '@slayzone/trpc-server'
import { describe, expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { canAccess, invalidateAccessCache, resource, setHubDiskComputer } from '../access'
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

  test("hub-disk kinds: A's computer's report gives A nothing, and B keeps B's own", async () => {
    for (const kind of ['ownedPath', 'pathTree'] as const) {
      expect(await decide(A, kind, 'cA'), `${kind} A on cA`).toBe(false)
      expect(await decide(B, kind, 'cB'), `${kind} B on cB`).toBe(true)
    }
  })

  test('a root with no computer (the hub’s own) never loses a tie to a named computer', async () => {
    expect(await decide(A, 'path', 'cA')).toBe(false)
  })
})

describe("Q1: a remote computer's folders never own anything on the hub's disk", () => {
  const placeOnA = (root: string) =>
    sql(
      `INSERT OR REPLACE INTO project_placements (computer_id, project_id, root_path, status, updated_at)
       VALUES ('cA', 'pA', ?, 'ready', 1)`,
      root
    )
  const hosts = '/etc/hosts'
  fs.mkdirSync(join(bRoot, 'sub'), { recursive: true })
  fs.writeFileSync(join(bRoot, 'sub', 'b.txt'), 'B-SUB')

  for (const [what, placed, readPath] of [
    ["a file of B's", join(bRoot, 'secret.txt'), join(bRoot, 'secret.txt')],
    ["a folder deeper in B's", join(bRoot, 'sub'), join(bRoot, 'sub', 'b.txt')],
    ['/', '/', hosts],
    ['/etc/hosts', hosts, hosts]
  ] as const) {
    test(`A's computer reports ${what}: A still cannot read it`, async () => {
      sql(`DELETE FROM project_placements WHERE computer_id = 'cA'`)
      placeOnA(placed)
      invalidateAccessCache()
      expect(await outcome(as(A).artifacts.upload({ taskId: 'tA', sourcePath: readPath }))).toBe(
        'NOT_FOUND'
      )
      expect(
        await outcome(
          as(A).artifacts.uploadDir({
            taskId: 'tA',
            dirPath: join(bRoot, 'sub'),
            parentFolderId: null
          })
        )
      ).toBe('NOT_FOUND')
    })
  }

  test("A's computer reports B's folder exactly: B is not locked out", async () => {
    sql(`DELETE FROM project_placements WHERE computer_id = 'cA'`)
    placeOnA(bRoot)
    invalidateAccessCache()
    const art = await as(B).artifacts.upload({
      taskId: 'tB',
      sourcePath: join(bRoot, 'secret.txt')
    })
    expect(await as(B).artifacts.readContent({ id: art!.id })).toBe('B-SECRET')
  })

  test("the hub's own local computer is a record of the hub's disk: its folders count", async () => {
    sql(
      `INSERT INTO computers (id, name, platform, version, capabilities_json, created_at, owner_user_id)
       VALUES ('cLocal', 'local', 'darwin', '1', '[]', 1, ?)`,
      A
    )
    const aMore = join(base, 'a-more')
    fs.mkdirSync(aMore, { recursive: true })
    fs.writeFileSync(join(aMore, 'x.txt'), 'A-MORE')
    sql(
      `INSERT INTO project_placements (computer_id, project_id, root_path, status, updated_at)
       VALUES ('cLocal', 'pA', ?, 'ready', 1)`,
      aMore
    )
    setHubDiskComputer('cLocal')
    try {
      invalidateAccessCache()
      const art = await as(A).artifacts.upload({ taskId: 'tA', sourcePath: join(aMore, 'x.txt') })
      expect(await as(A).artifacts.readContent({ id: art!.id })).toBe('A-MORE')
      expect(
        await outcome(as(B).artifacts.upload({ taskId: 'tB', sourcePath: join(aMore, 'x.txt') }))
      ).toBe('NOT_FOUND')
    } finally {
      setHubDiskComputer(null)
    }
  })
})

// Round-10 R10-1: a login hub whose computer startup failed had no folder host, and
// projects.update / create then wrote the legacy project path (a record OF the hub's
// disk) after only the computer-side check: B set pB's path to `/` and read
// /etc/hosts. On a hub with login the legacy column is never written, whatever the
// boot order (the hub also refuses to boot without a host: boot rule B18).
describe("R10-1: on a login hub a project's legacy path is never written", () => {
  test('projects.update {path}: refused, nothing recorded, and /etc/hosts stays refused', async () => {
    const b = as(B)
    const before = h.db.prepare("SELECT path FROM projects WHERE id = 'pB'").get()
    expect(await outcome(b.projects.update({ id: 'pB', path: '/' } as never))).not.toBe('ok')
    expect(h.db.prepare("SELECT path FROM projects WHERE id = 'pB'").get()).toEqual(before)
    invalidateAccessCache()
    expect(await outcome(b.artifacts.upload({ taskId: 'tB', sourcePath: '/etc/hosts' }))).toBe(
      'NOT_FOUND'
    )
  })

  test('projects.create {path}: refused, no project made', async () => {
    const count = () =>
      (
        h.db.prepare("SELECT COUNT(*) AS n FROM projects WHERE name = 'R10-1'").get() as {
          n: number
        }
      ).n
    expect(
      await outcome(as(B).projects.create({ name: 'R10-1', color: '#000', path: '/' } as never))
    ).not.toBe('ok')
    expect(count()).toBe(0)
  })
})
