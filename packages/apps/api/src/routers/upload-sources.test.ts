/**
 * T-107: the procedures that copy a CLIENT-NAMED source path off the hub's own disk —
 * `artifacts.upload` / `pasteFiles` / `uploadDir` and `projects.uploadIcon` — never
 * hand a user the hub's own files (its database, auth store, SSO certificate and key)
 * or another user's. Through the real `appRouter` with login on, so the owner gate
 * (access.ts `path` / `pathTree`) and the T-06 refusal run exactly as on the hub.
 *
 * On a hub with processes switched off (`SLAYZONE_HUB_ENABLE_PROCESSES=0`, Normain)
 * nothing is read from the hub's disk except its own artifact store (`NO_COMPUTER_
 * CONNECTED` otherwise). With login off (the desktop app's hub) everything is as before.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/api/src/routers/upload-sources.test.ts
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { describe, test, expect } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { setAuthGate } from '@slayzone/trpc-server'
import { appRouter } from '../router.js'

const h = await createTestHarness()
const sql = (s: string, ...p: unknown[]): void => void h.db.prepare(s).run(...p)
setSecurityLogSink(() => undefined)
setAuthGate(() => true)

// ── the hub's disk ────────────────────────────────────────────────────────────
//   <base>/hub-root          SLAYZONE_ROOT and the data root: database, auth store
//   <base>/secrets           the Entra certificate + key, outside the root
//   <base>/a-proj            A's project (with B's project nested in it)
//   <base>/nobodys           in no project
const base = realpathSync(mkdtempSync(join(tmpdir(), 'slz-t107-')))
const hubRoot = join(base, 'hub-root')
const secrets = join(base, 'secrets')
const aRoot = join(base, 'a-proj')
const bRoot = join(aRoot, 'vendor', 'b-proj')
const loose = join(base, 'nobodys')
for (const d of [join(hubRoot, 'sub'), secrets, join(aRoot, 'docs'), bRoot, loose])
  mkdirSync(d, { recursive: true })

const MARK = {
  db: 'HUB-DATABASE',
  auth: 'HUB-AUTH-STORE',
  key: 'SSO-PRIVATE-KEY',
  cert: 'SSO-CERTIFICATE',
  b: 'B-SECRET'
}
const hubDb = join(hubRoot, 'slayzone.data.sqlite')
const authDb = join(hubRoot, 'slayzone.auth.sqlite')
const ssoKey = join(secrets, 'sso-key.pem')
const ssoCert = join(secrets, 'sso-cert.pem')
writeFileSync(hubDb, MARK.db)
writeFileSync(authDb, MARK.auth)
writeFileSync(ssoKey, MARK.key)
writeFileSync(ssoCert, MARK.cert)
writeFileSync(join(bRoot, 'secret.txt'), MARK.b)
writeFileSync(join(bRoot, 'icon.png'), MARK.b)
writeFileSync(join(aRoot, 'README.md'), 'A-OWN')
writeFileSync(join(aRoot, 'icon.png'), 'A-ICON')
writeFileSync(join(aRoot, 'docs', 'notes.md'), 'A-NOTES')
writeFileSync(join(loose, 'loose.txt'), 'NOBODYS')
// What A can plant inside A's own project:
symlinkSync(hubRoot, join(aRoot, 'hub-link')) // a link into the hub's state directory
symlinkSync(join(hubRoot, 'sub'), join(aRoot, 'sub-link')) // `sub-link/..` IS the hub root
symlinkSync(ssoKey, join(aRoot, 'key-link.pem'))
symlinkSync(ssoKey, join(aRoot, 'key.png'))
symlinkSync(hubDb, join(aRoot, 'db.png'))

process.env.SLAYZONE_ROOT = hubRoot
process.env.SLAYZONE_HUB_SSO_CERT_PATH = ssoCert
process.env.SLAYZONE_HUB_SSO_KEY_PATH = ssoKey

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

const ctx = { db: h.slayDb, dataRoot: hubRoot }
const as = (userId: string | null) =>
  appRouter.createCaller({
    ...ctx,
    principal: userId ? { userId, role: 'user' as const, scopes: ['full' as const] } : null
  })
const a = as(A)

/** 'ok', 'NOT_FOUND' (the owner gate), 'FORBIDDEN:<appCode>', or the message. */
async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'ok'
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string }; message?: string }
    if (err.code === 'NOT_FOUND') return 'NOT_FOUND'
    if (err.code === 'FORBIDDEN' && err.cause?.code) return `FORBIDDEN:${err.cause.code}`
    return String(err.message)
  }
}

/** Every file the hub wrote under its root (artifacts, version blobs, icons) that
 *  holds something A must never get. */
function leaked(): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (p === hubDb || p === authDb) continue
      if (statSync(p).isDirectory()) walk(p)
      else {
        const body = readFileSync(p, 'utf-8')
        for (const m of Object.values(MARK)) if (body.includes(m)) found.push(`${m} in ${p}`)
      }
    }
  }
  walk(hubRoot)
  return found
}

/** Everything A must never get, as source paths. `..` is spelled out, never joined. */
const FORBIDDEN_SOURCES: [string, string][] = [
  ["B's file (nested inside A's project)", join(bRoot, 'secret.txt')],
  ["the hub's database", hubDb],
  ["the hub's auth store", authDb],
  ['a link into the hub state directory', join(aRoot, 'hub-link', 'slayzone.data.sqlite')],
  ['plain `..` into the hub root', `${aRoot}/../hub-root/slayzone.auth.sqlite`],
  [
    '`..` after a link (the kernel walks the link first)',
    `${aRoot}/sub-link/../slayzone.data.sqlite`
  ],
  ['the SSO private key (outside the root)', ssoKey],
  ['the SSO certificate (outside the root)', ssoCert],
  ['a link to the SSO key inside A’s project', join(aRoot, 'key-link.pem')]
]

describe('T-107 artifacts.upload (login on)', () => {
  test("A's own project file: copied", async () => {
    const art = await a.artifacts.upload({ taskId: 'tA', sourcePath: join(aRoot, 'README.md') })
    expect(await a.artifacts.readContent({ id: art!.id })).toBe('A-OWN')
  })
  for (const [what, src] of FORBIDDEN_SOURCES) {
    test(`${what}: refused`, async () => {
      expect(await outcome(a.artifacts.upload({ taskId: 'tA', sourcePath: src }))).toBe('NOT_FOUND')
    })
  }
})

describe('T-107 artifacts.pasteFiles (login on)', () => {
  test("A's own project file: copied", async () => {
    const created = await a.artifacts.pasteFiles({
      sourcePaths: [join(aRoot, 'README.md')],
      destTaskId: 'tA',
      destFolderId: null
    })
    expect(created).toHaveLength(1)
  })
  for (const [what, src] of FORBIDDEN_SOURCES) {
    test(`${what}: refused, and nothing of a mixed list is copied`, async () => {
      const before = (await a.artifacts.getByTask({ taskId: 'tA' })).length
      const paste = a.artifacts.pasteFiles({
        sourcePaths: [join(aRoot, 'README.md'), src],
        destTaskId: 'tA',
        destFolderId: null
      })
      expect(await outcome(paste)).toBe('NOT_FOUND')
      expect((await a.artifacts.getByTask({ taskId: 'tA' })).length).toBe(before)
    })
  }
})

describe('T-107 artifacts.uploadDir (login on): the whole tree is checked', () => {
  test("A's own directory: copied", async () => {
    const r = await a.artifacts.uploadDir({
      taskId: 'tA',
      dirPath: join(aRoot, 'docs'),
      parentFolderId: null
    })
    expect(r.artifacts.map((x) => x.title)).toEqual(['notes.md'])
  })
  const trees: [string, string][] = [
    ["the hub's state directory", hubRoot],
    ['a link to it inside A’s project', join(aRoot, 'hub-link')],
    ['`..` after a link (the hub root)', `${aRoot}/sub-link/..`],
    ["A's project, which holds B's nested project", aRoot],
    ["a directory in nobody's project that holds the hub root", base],
    ['the directory holding the SSO key and certificate', secrets]
  ]
  for (const [what, dir] of trees) {
    test(`${what}: refused`, async () => {
      expect(
        await outcome(a.artifacts.uploadDir({ taskId: 'tA', dirPath: dir, parentFolderId: null }))
      ).toBe('NOT_FOUND')
    })
  }
})

describe('T-107 projects.uploadIcon (login on)', () => {
  test("A's own image: copied", async () => {
    const p = await a.projects.uploadIcon({ projectId: 'pA', sourcePath: join(aRoot, 'icon.png') })
    expect(readFileSync(p.icon_image_path!, 'utf-8')).toBe('A-ICON')
  })
  const icons: [string, string][] = [
    ["B's image", join(bRoot, 'icon.png')],
    ["a `.png` link to the hub's database", join(aRoot, 'db.png')],
    ['a `.png` link to the SSO key', join(aRoot, 'key.png')]
  ]
  for (const [what, src] of icons) {
    test(`${what}: refused`, async () => {
      expect(await outcome(a.projects.uploadIcon({ projectId: 'pA', sourcePath: src }))).toBe(
        'NOT_FOUND'
      )
    })
  }
})

describe('T-107 a project rooted at <ROOT> or at / (its owner sets the path)', () => {
  test('a project at <ROOT>, or inside it, cannot be created or moved there', async () => {
    expect(await outcome(a.projects.create({ name: 'r', color: '#000000', path: hubRoot }))).toBe(
      'NOT_FOUND'
    )
    expect(
      await outcome(a.projects.update({ id: 'pA', path: join(hubRoot, 'sub') } as never))
    ).toBe('NOT_FOUND')
  })
  test('a project at / still gives no hub state, SSO file or other user', async () => {
    const slash = await a.projects.create({
      name: 'slash',
      color: '#000000',
      path: join(base, 'x')
    })
    try {
      await a.projects.update({ id: slash.id, path: '/' } as never)
      for (const src of [hubDb, authDb, ssoKey, ssoCert, join(bRoot, 'secret.txt')]) {
        expect(await outcome(a.artifacts.upload({ taskId: 'tA', sourcePath: src }))).toBe(
          'NOT_FOUND'
        )
      }
      for (const dir of ['/', base, secrets]) {
        expect(
          await outcome(a.artifacts.uploadDir({ taskId: 'tA', dirPath: dir, parentFolderId: null }))
        ).toBe('NOT_FOUND')
      }
    } finally {
      sql('DELETE FROM projects WHERE id = ?', slash.id)
    }
  })
})

describe('T-107 processes off (Normain): nothing off the hub disk but its artifact store', () => {
  const off = async (fn: () => Promise<void>): Promise<void> => {
    process.env.SLAYZONE_HUB_ENABLE_PROCESSES = '0'
    try {
      await fn()
    } finally {
      delete process.env.SLAYZONE_HUB_ENABLE_PROCESSES
    }
  }
  const REFUSED = 'FORBIDDEN:NO_COMPUTER_CONNECTED'
  test("A's own project file, directory and icon: refused (the hub holds no project files)", () =>
    off(async () => {
      expect(
        await outcome(a.artifacts.upload({ taskId: 'tA', sourcePath: join(aRoot, 'README.md') }))
      ).toBe(REFUSED)
      expect(
        await outcome(
          a.artifacts.uploadDir({
            taskId: 'tA',
            dirPath: join(aRoot, 'docs'),
            parentFolderId: null
          })
        )
      ).toBe(REFUSED)
      expect(
        await outcome(
          a.projects.uploadIcon({ projectId: 'pA', sourcePath: join(aRoot, 'icon.png') })
        )
      ).toBe(REFUSED)
      expect(
        await outcome(
          a.artifacts.pasteFiles({
            sourcePaths: [join(aRoot, 'README.md')],
            destTaskId: 'tA',
            destFolderId: null
          })
        )
      ).toBe(REFUSED)
    }))
  test("a file in nobody's project: refused", () =>
    off(async () => {
      expect(
        await outcome(a.artifacts.upload({ taskId: 'tA', sourcePath: join(loose, 'loose.txt') }))
      ).toBe(REFUSED)
      expect(
        await outcome(
          a.artifacts.pasteFiles({
            sourcePaths: [join(loose, 'loose.txt')],
            destTaskId: 'tA',
            destFolderId: null
          })
        )
      ).toBe(REFUSED)
    }))
  test("pasting or duplicating A's own artifact (hub storage): still works", async () => {
    const art = await a.artifacts.create({ taskId: 'tA', title: 'dup.md', content: 'DUP' } as never)
    const file = await a.artifacts.getFilePath({ id: art!.id })
    await off(async () => {
      const created = await a.artifacts.pasteFiles({
        sourcePaths: [file!],
        destTaskId: 'tA',
        destFolderId: null
      })
      expect(created).toHaveLength(1)
      expect(await a.artifacts.readContent({ id: created[0]!.id })).toBe('DUP')
    })
  })
})

describe('T-107 login off (the desktop app): as before', () => {
  test('any readable path is copied, with no principal and processes on', async () => {
    setAuthGate(() => false)
    try {
      const desk = as(null)
      const art = await desk.artifacts.upload({
        taskId: 'tA',
        sourcePath: join(loose, 'loose.txt')
      })
      expect(await desk.artifacts.readContent({ id: art!.id })).toBe('NOBODYS')
      const pasted = await desk.artifacts.pasteFiles({
        sourcePaths: [join(aRoot, 'README.md')],
        destTaskId: 'tB',
        destFolderId: null
      })
      expect(pasted).toHaveLength(1)
    } finally {
      setAuthGate(() => true)
    }
  })
})

describe('T-107 afterwards', () => {
  test('no hub-stored file holds the hub’s state, an SSO file or B’s content', () => {
    expect(leaked()).toEqual([])
  })
})
