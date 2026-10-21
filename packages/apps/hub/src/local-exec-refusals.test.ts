/**
 * T-06: a hub with `SLAYZONE_HUB_ENABLE_PROCESSES=0` and zero computers never execs or
 * touches project files on its own machine. Every hub-local call — the workspace fs
 * fallback, git and `gh` (incl. the routed executor's no-computer fallback), the shell
 * PATH/which probes, file and autocomplete scans, turn snapshots, `slay init`, the OS
 * opener, the desktop bridge's host calls — refuses with `NO_COMPUTER_CONNECTED` and one
 * `hub.local_exec` audit line.
 *
 * Proved on the exec layer, not only at the router: `child_process` and `fs` are
 * spied (`syncBuiltinESMExports`, installed before any module under test loads), so
 * "refused" also means no process was started and nothing under a directory outside
 * the hub's root was opened. The wire shape (tRPC FORBIDDEN + `data.appCode`) is
 * checked for the routers a client calls. A call routed to a (fake) computer still
 * goes there, and with the switch unset everything runs locally exactly as before —
 * which also shows the spies see real calls.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *     --experimental-loader ./packages/shared/test-utils/loader.ts \
 *     packages/apps/hub/src/local-exec-refusals.test.ts
 */
import { EventEmitter } from 'node:events'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import superjson from 'superjson'
import {
  createTestHarness,
  describe,
  expect,
  test
} from '../../../shared/test-utils/ipc-harness.js'

// --- A directory outside the hub's root, holding something worth reading --------
const OUTSIDE = realpathSync(mkdtempSync(join(tmpdir(), 't06-outside-')))
const SECRET = 'project-secret-7f3a'
writeFileSync(join(OUTSIDE, 'secret.txt'), SECRET)
mkdirSync(join(OUTSIDE, '.git'))
const outsideForms = [OUTSIDE, OUTSIDE.replace(/^\/private\//, '/')]

const h = await createTestHarness()

// --- Spies: installed BEFORE any module under test is imported -----------------
const require = createRequire(import.meta.url)
const cp = require('node:child_process') as Record<string, unknown>
const fs = require('node:fs') as Record<string, unknown>
const fsp = require('node:fs/promises') as Record<string, unknown>

const execCalls: string[] = []
let blockExec = true
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
  const orig = cp[name] as (...a: unknown[]) => unknown
  cp[name] = function (this: unknown, ...args: unknown[]) {
    execCalls.push(`${name} ${String(args[0])}`)
    if (blockExec) throw new Error(`test: child_process.${name} reached`)
    return orig.apply(this, args)
  }
}

const touched: string[] = []
const isOutside = (v: unknown): boolean =>
  (typeof v === 'string' || v instanceof URL) &&
  outsideForms.some((p) => String(v instanceof URL ? v.pathname : v).startsWith(p))
function watchPaths(mod: Record<string, unknown>, label: string, names: string[]): void {
  for (const name of names) {
    const orig = mod[name] as ((...a: unknown[]) => unknown) & { native?: unknown }
    if (typeof orig !== 'function') continue
    const wrap = (fn: (...a: unknown[]) => unknown, as: string) =>
      function (this: unknown, ...args: unknown[]) {
        if (args.some(isOutside)) touched.push(`${label}.${as}`)
        return fn.apply(this, args)
      }
    const w = Object.assign(wrap(orig, name), orig)
    if (typeof orig.native === 'function') {
      ;(w as { native?: unknown }).native = wrap(
        orig.native as (...a: unknown[]) => unknown,
        `${name}.native`
      )
    }
    mod[name] = w
  }
}
watchPaths(fs, 'fs', [
  'readFileSync',
  'readdirSync',
  'statSync',
  'lstatSync',
  'existsSync',
  'accessSync',
  'realpathSync',
  'openSync',
  'writeFileSync',
  'chmodSync',
  'mkdirSync',
  'rmSync',
  'cpSync',
  'watch',
  'readFile',
  'readdir',
  'stat',
  'access',
  'open'
])
watchPaths(fsp, 'fsp', [
  'readFile',
  'readdir',
  'stat',
  'lstat',
  'access',
  'realpath',
  'open',
  'writeFile',
  'mkdir',
  'rm',
  'cp'
])
syncBuiltinESMExports()

// --- Modules under test (after the spies) --------------------------------------
const { setSecurityLogSink } = await import('@slayzone/platform/security-log')
const { isHubSwitchedOffError } = await import('@slayzone/platform/hub-switch-refusal')
const { appRouter, setAppDeps, getWorkspaceDeps } = await import('@slayzone/transport/server')
const { createLocalWorkspaceFs } = await import('@slayzone/file-editor/server')
const { createRemoteFsAdapters } = await import('@slayzone/computer-transport/server')
const worktrees = await import('@slayzone/worktrees/server')
const { execGit } = await import('../../../domains/worktrees/src/server/exec-async.js')
// By path, not `./merge-ai`: the test loader redirects that specifier to a mock.
const { runAiCommand } = await import('../../../domains/worktrees/src/server/merge-ai.js')
const { defaultWorktreeExecAdapters } = await import('@slayzone/task/server')
const terminal = await import('@slayzone/terminal/server')
const { listProjectFiles } = await import('../../../domains/terminal/src/server/files-scan.js')
const turns = await import('../../../domains/agent-turns/src/server/git-snapshot.js')
const { recordTurnBoundary } = await import(
  '../../../domains/agent-turns/src/server/turn-tracker.js'
)
const { initAiConfigOps } = await import('@slayzone/ai-config/server')
const shellNative = await import('./shell-native.js')
const { createHostBridge } = await import('./host-bridge.js')

initAiConfigOps(h.slayDb)

const lines: Array<Record<string, unknown> & { detail: Record<string, unknown> }> = []
setSecurityLogSink((line) => lines.push(JSON.parse(line)))

/** The refusal `fn` raised (sync or async), or null. */
async function refusal(fn: () => unknown): Promise<unknown> {
  try {
    await fn()
    return null
  } catch (e) {
    return e
  }
}

/** Refused with NO_COMPUTER_CONNECTED, one `hub.local_exec` audit line, nothing run or read. */
async function expectRefused(name: string, fn: () => unknown): Promise<void> {
  const before = { lines: lines.length, exec: execCalls.length, touched: touched.length }
  const err = await refusal(fn)
  if (!isHubSwitchedOffError(err) || err.code !== 'NO_COMPUTER_CONNECTED') {
    throw new Error(`${name}: expected NO_COMPUTER_CONNECTED, got ${String(err)}`)
  }
  expect(err.message.startsWith('Connect a computer')).toBe(true)
  expect(lines.length).toBe(before.lines + 1)
  expect(lines[before.lines].event).toBe('hub.local_exec')
  expect(lines[before.lines].outcome).toBe('denied')
  expect(execCalls.slice(before.exec)).toEqual([])
  expect(touched.slice(before.touched)).toEqual([])
}

/**
 * For a helper that swallows a git error into a default: the exec seam still
 * refused (one audit line), nothing ran, nothing was read. The router gate turns
 * these into a real refusal on the wire (below).
 */
async function expectRefusedQuietly(name: string, fn: () => unknown): Promise<void> {
  const before = { lines: lines.length, exec: execCalls.length, touched: touched.length }
  await refusal(fn)
  if (lines.length !== before.lines + 1 || lines[before.lines].event !== 'hub.local_exec') {
    throw new Error(`${name}: expected one hub.local_exec line, got ${lines.length - before.lines}`)
  }
  expect(execCalls.slice(before.exec)).toEqual([])
  expect(touched.slice(before.touched)).toEqual([])
}

type WireError = { message: string; data: { code: string; httpStatus: number; appCode?: string } }

async function call(
  path: string,
  input: unknown,
  method: 'POST' | 'GET' = 'GET'
): Promise<{ status: number; data?: unknown; error?: WireError }> {
  const url =
    method === 'GET'
      ? `http://hub/trpc/${path}?input=${encodeURIComponent(JSON.stringify(superjson.serialize(input)))}`
      : `http://hub/trpc/${path}`
  const res = await fetchRequestHandler({
    endpoint: '/trpc',
    req: new Request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(superjson.serialize(input)) : undefined
    }),
    router: appRouter,
    createContext: () => ({
      db: h.slayDb,
      dataRoot: '/tmp',
      req: { socket: { remoteAddress: '198.51.100.9' } } as never,
      principal: { userId: 'user-7', role: 'user' as const, scopes: ['full'] as const }
    })
  })
  const body = (await res.json()) as {
    result?: { data: { json: unknown } }
    error?: { json: WireError }
  }
  return { status: res.status, data: body.result?.data.json, error: body.error?.json }
}

// Wired the way composition.ts wires a standalone hub (no desktop bridge).
setAppDeps({
  filesPathExists: shellNative.pathExists,
  shellOpenPath: shellNative.openPath,
  shellShowItemInFolder: shellNative.showItemInFolder,
  shellOpenExternal: (url: string) => shellNative.openExternal(url)
} as never)

/** A computer that answers `fs.readFile` and records what it was asked. */
const gatewayCalls: Array<[string, string]> = []
const fakeGateway = {
  request: async (computerId: string, method: string) => {
    gatewayCalls.push([computerId, method])
    return { content: 'from the computer' }
  },
  events: new EventEmitter(),
  listComputers: () => []
} as never
const routedFs = createRemoteFsAdapters({ gateway: fakeGateway, local: createLocalWorkspaceFs() })

process.env.SLAYZONE_HUB_ENABLE_PROCESSES = '0'

await describe('processes off, zero computers: every hub-local call refuses (exec layer)', () => {
  const local = createLocalWorkspaceFs()
  test('workspace fs: browse, read, git status, discovery, probe, watch', async () => {
    await expectRefused('listRoots', () => local.listRoots())
    await expectRefused('listDir', () => local.listDir(OUTSIDE))
    await expectRefused('readFile', () => local.readFile(OUTSIDE, 'secret.txt'))
    await expectRefused('readDir', () => local.readDir(OUTSIDE, ''))
    await expectRefused('gitStatus', () => local.gitStatus(OUTSIDE))
    await expectRefused('discoverRepos', () => local.discoverRepos(OUTSIDE))
    await expectRefused('pathExists', () => local.pathExists(OUTSIDE))
    await expectRefused('searchFiles', () => local.searchFiles(OUTSIDE, 'secret'))
    await expectRefused('watch', () => local.watch(OUTSIDE, () => undefined))
  })
  test('workspace fs: the routed adapter with no computer, and the transport default', async () => {
    await expectRefused('routed, null computer', () =>
      routedFs.readFile(null, OUTSIDE, 'secret.txt')
    )
    await expectRefused('transport default deps', () =>
      getWorkspaceDeps().fs.listDir(null, OUTSIDE)
    )
  })
  test('git: execGit, helpers, watcher', async () => {
    await expectRefused('execGit', () => execGit(['status'], { cwd: OUTSIDE }))
    await expectRefusedQuietly('getCurrentBranch', () => worktrees.getCurrentBranch(OUTSIDE))
    await expectRefused('createBranch', () => worktrees.createBranch(OUTSIDE, 'b'))
    await expectRefused('watcher', () => worktrees.getGitWatcher().subscribe(OUTSIDE))
  })
  test('gh: the local executor and the default seam', async () => {
    await expectRefused('runGhLocally', () => worktrees.runGhLocally(['auth'], { cwd: OUTSIDE }))
    await expectRefused('listOpenPrs', () => worktrees.listOpenPrs(OUTSIDE))
    await expectRefused('checkGhInstalled', () => worktrees.checkGhInstalled())
  })
  test('merge-ai', async () => {
    await expectRefused('runAiCommand', () => runAiCommand('claude-code', 'x'))
  })
  test('task worktree seam default (live before the gateway, and if its init fails)', async () => {
    const a = defaultWorktreeExecAdapters
    await expectRefused('createWorktree', () => a.createWorktree('t', OUTSIDE, OUTSIDE, 'b'))
    await expectRefused('removeWorktree', () => a.removeWorktree('t', OUTSIDE, OUTSIDE))
    await expectRefused('isGitRepo', () => a.isGitRepo('t', OUTSIDE))
    await expectRefused('pathExists', () => a.pathExists('t', OUTSIDE))
  })
  test('terminal: shell PATH, which, terminal-mode test, file + autocomplete scans', async () => {
    await expectRefused('getEnrichedPath', () => terminal.getEnrichedPath())
    await expectRefused('whichBinary', () => terminal.whichBinary('git'))
    await expectRefused('modesTest', () => terminal.createPtyOps(h.slayDb).terminalModesTest('git'))
    await expectRefused('listProjectFiles', () => listProjectFiles(OUTSIDE, ''))
    const chat = terminal.createChatOps(h.slayDb)
    await expectRefused('listSkills', () => chat.listSkills(OUTSIDE))
    await expectRefused('listCommands', () => chat.listCommands(OUTSIDE))
    await expectRefused('listAgents', () => chat.listAgents(OUTSIDE))
  })
  test('agent turns: snapshot and list probes; the turn hook skips quietly', async () => {
    await expectRefused('snapshotWorktree', () => turns.snapshotWorktree(OUTSIDE, 'turn-1'))
    await expectRefused('getHeadSha', () => turns.getHeadSha(OUTSIDE))
    const before = { lines: lines.length, exec: execCalls.length }
    await recordTurnBoundary(h.slayDb, 'tab-1', 'prompt')
    expect(lines.length).toBe(before.lines)
    expect(execCalls.length).toBe(before.exec)
  })
  test('OS opener and path probe (standalone hub)', async () => {
    await expectRefused('openPath', () => shellNative.openPath(OUTSIDE))
    await expectRefused('openExternal', () => shellNative.openExternal('https://example.com'))
    await expectRefused('showItemInFolder', () => shellNative.showItemInFolder(OUTSIDE))
    await expectRefused('pathExists', () => shellNative.pathExists(OUTSIDE))
  })
  test('desktop bridge: host-side open/probe/install refused before the host is asked', async () => {
    const bridge = createHostBridge('ws://127.0.0.1:9/cap', { getTrpcPort: () => 0 })
    try {
      await expectRefused('shellOpenPath', () => bridge.appDeps.shellOpenPath(OUTSIDE))
      await expectRefused('filesPathExists', () => bridge.appDeps.filesPathExists(OUTSIDE))
      await expectRefused('appInstallCli', () => bridge.appDeps.appInstallCli())
    } finally {
      bridge.dispose()
    }
  })
})

await describe('processes off, zero computers: the wire shape (tRPC)', () => {
  for (const [path, input] of [
    ['worktrees.getCurrentBranch', { path: OUTSIDE }],
    // Swallows a git error into `false` — the router gate refuses before that.
    ['worktrees.isGitRepo', { path: OUTSIDE }],
    ['worktrees.getConflictContent', { repoPath: OUTSIDE, filePath: 'secret.txt' }],
    ['worktrees.checkGhInstalled', undefined],
    // A routed `gh` call: no computer → the local executor → refused deep down.
    ['worktrees.listOpenPrs', { repoPath: OUTSIDE }],
    ['workspace.listDir', { path: OUTSIDE }],
    ['fileEditor.readFile', { rootPath: OUTSIDE, filePath: 'secret.txt' }],
    ['agentTurns.list', { worktreePath: OUTSIDE }],
    ['app.files.pathExists', { filePath: OUTSIDE }]
  ] as const) {
    test(`${path}: FORBIDDEN + NO_COMPUTER_CONNECTED, audited as the caller`, async () => {
      const before = { lines: lines.length, exec: execCalls.length, touched: touched.length }
      const res = await call(path, input)
      expect(res.status).toBe(403)
      expect(res.error?.data.code).toBe('FORBIDDEN')
      expect(res.error?.data.appCode).toBe('NO_COMPUTER_CONNECTED')
      expect(res.error?.message.startsWith('Connect a computer')).toBe(true)
      expect(JSON.stringify(res).includes(SECRET)).toBe(false)
      expect(lines.length).toBe(before.lines + 1)
      expect(lines[before.lines].event).toBe('hub.local_exec')
      expect(lines[before.lines].actor).toBe('user-7')
      expect(lines[before.lines].route).toBe(`trpc ${path}`)
      expect(execCalls.slice(before.exec)).toEqual([])
      expect(touched.slice(before.touched)).toEqual([])
    })
  }
  test('aiConfig.setupSlay: FORBIDDEN, `slay init` never runs', async () => {
    const before = execCalls.length
    const res = await call('aiConfig.setupSlay', { projectPath: OUTSIDE }, 'POST')
    expect(res.status).toBe(403)
    expect(res.error?.data.appCode).toBe('NO_COMPUTER_CONNECTED')
    expect(execCalls.length).toBe(before)
  })
  test('workspace.pathExists answers "could not ask" with the code', async () => {
    const res = await call('workspace.pathExists', { path: OUTSIDE })
    expect(res.status).toBe(200)
    const data = res.data as { reachable: boolean; exists: boolean; code?: string }
    expect(data.reachable).toBe(false)
    expect(data.exists).toBe(false)
    expect(data.code).toBe('NO_COMPUTER_CONNECTED')
  })
  test('nothing was spawned and nothing outside the root was opened, in total', () => {
    expect(execCalls).toEqual([])
    expect(touched).toEqual([])
  })
})

await describe('processes off, a computer connected: routed as today', () => {
  test('workspace fs routes to the computer, no audit line, nothing local', async () => {
    const before = { lines: lines.length, exec: execCalls.length, touched: touched.length }
    const res = await routedFs.readFile('computer-1', OUTSIDE, 'secret.txt')
    expect(res.content).toBe('from the computer')
    expect(gatewayCalls).toEqual([['computer-1', 'fs.readFile']])
    expect(lines.length).toBe(before.lines)
    expect(execCalls.length).toBe(before.exec)
    expect(touched.length).toBe(before.touched)
  })
  test('gh routes through an installed executor, no audit line', async () => {
    const asked: string[][] = []
    worktrees.setGhExecutor(async (args) => {
      asked.push(args)
      return { status: 0, stdout: '[]', stderr: '' }
    })
    try {
      const before = lines.length
      expect(await worktrees.listOpenPrs(OUTSIDE)).toEqual([])
      expect(asked.length).toBe(1)
      expect(lines.length).toBe(before)
    } finally {
      worktrees.setGhExecutor(null)
    }
  })
})

await describe('defaults (switch unset): local, exactly as before', () => {
  test('workspace fs reads locally (and the fs spy sees it)', async () => {
    delete process.env.SLAYZONE_HUB_ENABLE_PROCESSES
    blockExec = false
    const before = { lines: lines.length, touched: touched.length }
    const res = createLocalWorkspaceFs().readFile(OUTSIDE, 'secret.txt')
    expect(res.content).toBe(SECRET)
    expect(touched.length).toBeGreaterThan(before.touched)
    expect(lines.length).toBe(before.lines)
  })
  test('git runs locally (and the child_process spy sees it)', async () => {
    const before = { lines: lines.length, exec: execCalls.length }
    const out = await execGit(['--version'], { cwd: OUTSIDE })
    expect(out.startsWith('git version')).toBe(true)
    expect(execCalls.length).toBeGreaterThan(before.exec)
    expect(lines.length).toBe(before.lines)
  })
  test('worktrees.isGitRepo answers over tRPC, no refusal', async () => {
    const before = lines.length
    const res = await call('worktrees.isGitRepo', { path: OUTSIDE })
    expect(res.status).toBe(200)
    expect(res.error).toBeUndefined()
    expect(lines.length).toBe(before)
  })
})

setSecurityLogSink()
h.cleanup()
