/**
 * N1: on a hub with login, a procedure that opens a CLIENT-NAMED path on the hub's own
 * disk needs that path inside a root the caller may access (access.ts `ownedPath`).
 * A path in no root used to be hub-wide — anything the hub process can read was
 * anybody's: its database through `/dev/fd/<n>`, its environment (the auth secret)
 * through `/proc/self/environ`, the hub OS user's home.
 *
 * The upload family lives in `upload-sources.test.ts`; this covers the rest: the
 * host's file probe and opener and the export/import test ops (they read the hub's
 * disk). One of each family that feat/move-to-computer moved to the computer (AI
 * config, file editor, git, tests panel) is pinned too: the hub never reads its own
 * disk for them — the computer's path jail and the gateway owner check decide there,
 * and with no computer the call is refused ("connect a computer"), never answered from
 * the hub. Through the real `appRouter` with login on, so the owner gate runs exactly
 * as on the hub. With login off (the desktop app's hub) everything is as before.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/api/src/routers/hub-local-paths.test.ts
 */
import { mkdirSync, mkdtempSync, openSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setHostCapabilitiesDeps, type HostCapabilities } from '@slayzone/host-capabilities/server'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { setAuthGate } from '@slayzone/trpc-server'
import { describe, expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { appRouter } from '../router.js'

const h = await createTestHarness()
const sql = (s: string, ...p: unknown[]): void => void h.db.prepare(s).run(...p)
setSecurityLogSink(() => undefined)
setAuthGate(() => true)

// The host seam, recorded: an allowed `openPath` must not open a real window here.
const opened: string[] = []
setHostCapabilitiesDeps({
  getHost: () =>
    ({
      filesPathExists: async () => true,
      shellOpenPath: async (p: string) => {
        opened.push(p)
        return ''
      }
    }) as unknown as HostCapabilities
})

//   <base>/hub-root   SLAYZONE_ROOT: the hub's database
//   <base>/a-proj     A's project
//   <base>/nobodys    in no project
const base = realpathSync(mkdtempSync(join(tmpdir(), 'slz-n1-')))
const hubRoot = join(base, 'hub-root')
const aRoot = join(base, 'a-proj')
const loose = join(base, 'nobodys')
for (const d of [hubRoot, aRoot, loose]) mkdirSync(d, { recursive: true })
const hubDb = join(hubRoot, 'slayzone.data.sqlite')
writeFileSync(hubDb, 'HUB-DATABASE')
writeFileSync(join(aRoot, 'README.md'), 'A-OWN')
writeFileSync(join(loose, 'loose.txt'), 'NOBODYS')
writeFileSync(join(loose, 'CLAUDE.md'), 'NOBODYS')
const dbFd = openSync(hubDb, 'r')
process.env.SLAYZONE_ROOT = hubRoot

const A = 'user-a'
sql(
  `INSERT INTO projects (id, name, color, owner_user_id, path) VALUES ('pA', 'A', '#111', ?, ?)`,
  A,
  aRoot
)

const ctx = { db: h.slayDb, dataRoot: hubRoot }
const as = (userId: string | null, role: 'user' | 'admin' = 'user') =>
  appRouter.createCaller({
    ...ctx,
    principal: userId ? { userId, role, scopes: ['full' as const] } : null
  })

/** 'NOT_FOUND' when the owner gate refused; anything else got past it. */
async function outcome(p: () => Promise<unknown>): Promise<string> {
  try {
    await p()
    return 'ok'
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return err.code === 'NOT_FOUND' ? 'NOT_FOUND' : `past-gate:${err.code ?? err.message}`
  }
}

type Caller = ReturnType<typeof as>

type Proc = [string, (c: Caller, dir: string, file: string) => Promise<unknown>]

/** Each hub-disk procedure, called with `dir` (a directory) and `file` (a file in it). */
const HUB_DISK: Proc[] = [
  ['app.files.pathExists', (c, _d, f) => c.app.files.pathExists({ filePath: f })],
  ['app.shell.openPath', (c, _d, f) => c.app.shell.openPath({ absPath: f })],
  [
    'app.exportImport.testExportAllToPath',
    (c, d) => c.app.exportImport.testExportAllToPath({ filePath: join(d, 'out.json') })
  ],
  [
    'app.exportImport.testExportProjectToPath',
    (c, d) =>
      c.app.exportImport.testExportProjectToPath({
        projectId: 'pA',
        filePath: join(d, 'out.json')
      })
  ]
]

/** Moved to the computer: the hub has no disk fallback for them. */
const ROUTED: Proc[] = [
  [
    'aiConfig.readContextFile',
    (c, d, f) => c.aiConfig.readContextFile({ filePath: f, projectPath: d })
  ],
  [
    'aiConfig.readProviderInstructions',
    (c, d) => c.aiConfig.readProviderInstructions({ projectPath: d, provider: 'claude' })
  ],
  [
    'fileEditor.readFile',
    (c, d, f) => c.fileEditor.readFile({ rootPath: d, filePath: f.slice(d.length + 1) })
  ],
  ['worktrees.getCurrentBranch', (c, d) => c.worktrees.getCurrentBranch({ path: d })],
  ['testPanel.scanFiles', (c, d) => c.testPanel.scanFiles({ projectId: 'pA', projectPath: d })]
]
const PROCS = [...HUB_DISK, ...ROUTED]

describe('N1: hub-local path procedures (login on)', () => {
  for (const [name, call] of HUB_DISK) {
    test(`${name}: A's own project — past the gate`, async () => {
      expect(await outcome(() => call(as(A), aRoot, join(aRoot, 'README.md')))).not.toBe(
        'NOT_FOUND'
      )
    })
    test(`${name}: a path in no project root — refused (never hub-wide)`, async () => {
      expect(await outcome(() => call(as(A), loose, join(loose, 'loose.txt')))).toBe('NOT_FOUND')
    })
    test(`${name}: /dev/fd/<the hub database> — refused`, async () => {
      expect(await outcome(() => call(as(A), '/dev/fd', `/dev/fd/${dbFd}`))).toBe('NOT_FOUND')
    })
  }
  for (const [name, call] of ROUTED) {
    test(`${name}: a path in no project root — never read on the hub`, async () => {
      expect(await outcome(() => call(as(A), loose, join(loose, 'loose.txt')))).toMatch(
        /^(NOT_FOUND|past-gate:FORBIDDEN)$/
      )
    })
    test(`${name}: /dev/fd/<the hub database> — refused`, async () => {
      expect(await outcome(() => call(as(A), '/dev/fd', `/dev/fd/${dbFd}`))).toBe('NOT_FOUND')
    })
  }
  test('app.exportImport.testImportFromPath (admin): only inside its own roots', async () => {
    const admin = as(A, 'admin')
    const own = () => admin.app.exportImport.testImportFromPath({ filePath: join(aRoot, 'x.json') })
    const nobodys = () =>
      admin.app.exportImport.testImportFromPath({ filePath: join(loose, 'loose.txt') })
    const fd = () => admin.app.exportImport.testImportFromPath({ filePath: `/dev/fd/${dbFd}` })
    expect(await outcome(own)).not.toBe('NOT_FOUND')
    expect(await outcome(nobodys)).toBe('NOT_FOUND')
    expect(await outcome(fd)).toBe('NOT_FOUND')
  })
  test('nothing outside A’s project was opened', () => {
    expect(opened.filter((p) => !p.startsWith(aRoot))).toEqual([])
  })
})

describe('N1 login off (the desktop app): as before', () => {
  for (const [name, call] of PROCS) {
    test(`${name}: a path in no project root — past the gate`, async () => {
      setAuthGate(() => false)
      try {
        expect(await outcome(() => call(as(null), loose, join(loose, 'loose.txt')))).not.toBe(
          'NOT_FOUND'
        )
      } finally {
        setAuthGate(() => true)
      }
    })
  }
})
