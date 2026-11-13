/**
 * T-27 computer-side hardening, at the dispatch level (`createHubRequestHandler`,
 * the one door every hub request comes through):
 *   - folder limits stay local: a hub-pushed `allowedRoots` change is refused and
 *     logged; the device's own config file is applied; the desktop's supervised
 *     computer still accepts its loopback hub's edits and can then run a terminal;
 *   - every hub request leaves exactly one local log line, with its actor and
 *     without content; no frame can read or clear that log;
 *   - a hub-started process never starts outside `allowedRoots`;
 *   - a request without an actor (a pre-v3 hub) is refused.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ComputerTransportErrorCodes,
  HubToComputerMethods,
  RpcError
} from '@slayzone/computer-transport/shared'
import { type ComputerConfig, loadComputerConfig } from './config'
import { setProtectedPaths } from './path-jail'
import { reloadLocalRoots } from './handlers/computer-config'
import type { ComputerDialer } from './handlers/types'
import { projectScopedDeps } from './project-scope.fixture'
import { createHubRequestHandler, startComputer } from './main'
import { createRequestLog, REQUEST_LOG_DIR_NAME, type RequestLog } from './request-log'

const dialer: ComputerDialer = { notify: () => true }
const ACTOR = { userId: 'user-42', route: 'trpc fileEditor.writeFile' }

let dir: string
let root: string
let stateDir: string
let log: RequestLog
const savedEnv = { ...process.env }

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'computer-t27-')))
  root = join(dir, 'work')
  stateDir = join(dir, 'state')
  mkdirSync(root, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  // computer-config persists through the ROOT-derived config path: keep it in the tmpdir.
  process.env.HOME = join(dir, 'home')
  process.env.SLAYZONE_ROOT = stateDir
  mkdirSync(process.env.HOME, { recursive: true })
  log = createRequestLog({ stateDir })
  setProtectedPaths([
    join(stateDir, 'computer.config.json'),
    join(stateDir, 'computer.state.json'),
    join(stateDir, REQUEST_LOG_DIR_NAME)
  ])
})

afterEach(() => {
  setProtectedPaths([])
  process.env = { ...savedEnv }
  rmSync(dir, { recursive: true, force: true })
})

function configWith(roots: string[], hubMayEditRoots = false): ComputerConfig {
  return {
    hubUrl: 'wss://hub.example.com/computers',
    name: 'cloud-device',
    allowedRoots: roots,
    capabilities: ['pty', 'git', 'fs', 'proc'],
    hubMayEditRoots
  }
}

function dispatchFor(config: ComputerConfig, folders: Record<string, string> = {}) {
  return createHubRequestHandler({
    shutdown: () => {},
    dialer,
    config,
    requestLog: log,
    hubHost: 'hub.example.com',
    ...projectScopedDeps(folders)
  })
}

function logLines(): Record<string, unknown>[] {
  return readFileSync(log.filePath, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

async function rejection(p: Promise<unknown>): Promise<RpcError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(RpcError)
  return err as RpcError
}

describe('folder limits stay local', () => {
  it('refuses a hub-pushed allowedRoots change and logs it as refused', async () => {
    const other = join(dir, 'other')
    mkdirSync(other)
    const config = configWith([root])
    const { handle } = dispatchFor(config)

    const err = await rejection(
      handle(HubToComputerMethods.computerSetAllowedRoots, { roots: [root, other] }, ACTOR)
    )
    expect(err.code).toBe(ComputerTransportErrorCodes.refusedByComputer)
    expect(err.message).toMatch(/slay computer roots cloud-device --add/)
    expect(config.allowedRoots).toEqual([root])

    const [line] = logLines()
    expect(line).toMatchObject({
      method: 'computer.setAllowedRoots',
      actor: ACTOR,
      result: 'refused',
      code: ComputerTransportErrorCodes.refusedByComputer,
      target: { roots: [root, other] }
    })
  })

  it('applies roots from the device’s own config file', () => {
    const added = join(dir, 'added')
    mkdirSync(added)
    const config = configWith([root])
    expect(reloadLocalRoots(config, [root, added])).toEqual([root, added])
    expect(config.allowedRoots).toEqual([root, added])
    // Unchanged / empty / all-unusable declarations leave the live set alone.
    expect(reloadLocalRoots(config, [root, added])).toBeNull()
    expect(reloadLocalRoots(config, [])).toBeNull()
    expect(reloadLocalRoots(config, [join(dir, 'ghost')])).toBeNull()
    expect(config.allowedRoots).toEqual([root, added])
  })

  it('a running standalone computer picks up a computer.config.json edit', async () => {
    const added = join(dir, 'added')
    mkdirSync(added)
    const config: ComputerConfig = {
      ...configWith([root]),
      hubUrl: 'ws://127.0.0.1:0/computers'
    }
    const handle = startComputer(config, {
      stateDir,
      credentialStore: {
        load: async () => null,
        save: async () => {},
        clear: async () => {},
        filePath: '/dev/null'
      }
    })
    try {
      writeFileSync(
        join(stateDir, 'computer.config.json'),
        JSON.stringify({ allowedRoots: [root, added] })
      )
      const deadline = Date.now() + 8000
      while (config.allowedRoots.length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200))
      }
      expect(config.allowedRoots).toEqual([root, added])
      expect(logLines().some((l) => l.method === 'local.allowedRoots' && l.hub === 'local')).toBe(
        true
      )
    } finally {
      await handle.stop()
    }
  }, 15_000)

  it('only the desktop’s supervised computer on a loopback hub lets the hub edit roots', () => {
    const supervised = loadComputerConfig({
      SLAYZONE_SUPERVISED: '1',
      SLAYZONE_HUB_ADDRESS: '127.0.0.1:4100'
    })
    expect(supervised.hubMayEditRoots).toBe(true)
    // A standalone computer — a Cloud Device — never, even on loopback.
    const standalone = loadComputerConfig(
      { SLAYZONE_HUB_ADDRESS: '127.0.0.1:4100' },
      {
        allowedRoots: [root]
      }
    )
    expect(standalone.hubMayEditRoots).toBe(false)
    // Supervised but dialing a remote hub: never.
    const remote = loadComputerConfig({
      SLAYZONE_SUPERVISED: '1',
      SLAYZONE_HUB_ADDRESS: 'hub.example.com'
    })
    expect(remote.hubMayEditRoots).toBe(false)
    // No file key turns it on.
    const fromFile = loadComputerConfig({ SLAYZONE_HUB_ADDRESS: '127.0.0.1:4100' }, {
      allowedRoots: [root],
      hubMayEditRoots: true
    } as never)
    expect(fromFile.hubMayEditRoots).toBe(false)
  })

  it('desktop local computer: its hub adds a project folder, then a terminal runs there', async () => {
    const project = join(dir, 'Volumes-project')
    mkdirSync(project)
    const config = configWith([root], true)
    const dispatch = dispatchFor(config, { p1: project })
    try {
      // Outside the jail first: refused.
      const before = await rejection(
        dispatch.handle(
          HubToComputerMethods.ptySpawn,
          {
            sessionId: 's-1',
            projectId: 'p1',
            command: '/bin/sh',
            args: ['-c', 'exit 0'],
            cwd: project
          },
          { userId: null, route: null }
        )
      )
      expect(before.code).toBe(ComputerTransportErrorCodes.refusedByComputer)

      const res = (await dispatch.handle(
        HubToComputerMethods.computerSetAllowedRoots,
        { roots: [root, project] },
        { userId: null, route: null }
      )) as { roots: string[] }
      expect(res.roots).toEqual([root, project])

      const spawned = (await dispatch.handle(
        HubToComputerMethods.ptySpawn,
        {
          sessionId: 's-2',
          projectId: 'p1',
          command: '/bin/sh',
          args: ['-c', 'exit 0'],
          cwd: project
        },
        { userId: null, route: null }
      )) as { pid: number }
      expect(typeof spawned.pid).toBe('number')
    } finally {
      dispatch.dispose()
    }
  })
})

describe('local request log', () => {
  it('writes exactly one line per request, with the actor and without content', async () => {
    const config = configWith([root])
    const { handle } = dispatchFor(config)

    await handle(
      HubToComputerMethods.fsWriteFile,
      { rootPath: root, filePath: 'notes.txt', content: 'SECRET-FILE-CONTENT' },
      ACTOR
    )
    await handle(HubToComputerMethods.gitIsGitRepo, { path: root }, ACTOR)
    await rejection(handle('bogus.method', {}, ACTOR))
    await rejection(
      handle(HubToComputerMethods.fsReadFile, { rootPath: '/etc', filePath: 'hosts' }, ACTOR)
    )
    await rejection(
      handle(
        HubToComputerMethods.ghExec,
        { args: ['pr', 'create', '--body', 'SECRET-PR-BODY'], cwd: '/', stdin: 'SECRET-STDIN' },
        ACTOR
      )
    )

    const lines = logLines()
    expect(lines.map((l) => [l.method, l.result])).toEqual([
      ['fs.writeFile', 'ok'],
      ['git.isGitRepo', 'ok'],
      ['bogus.method', 'error'],
      ['fs.readFile', 'refused'],
      ['gh.exec', 'refused']
    ])
    for (const l of lines) {
      expect(l.actor).toEqual(ACTOR)
      expect(l.hub).toBe('hub.example.com')
      expect(typeof l.ts).toBe('string')
    }
    expect(lines[0].target).toEqual({ rootPath: root, filePath: 'notes.txt' })
    expect(lines[4].target).toEqual({ cwd: '/', subcommand: 'pr create' })
    const raw = readFileSync(log.filePath, 'utf8')
    expect(raw).not.toMatch(/SECRET/)
    expect(statSync(log.filePath).mode & 0o777).toBe(0o600)
  })

  it('rotates by size and keeps the configured generations', () => {
    const small = createRequestLog({ stateDir: join(dir, 'rot'), maxBytes: 400, keep: 2 })
    for (let i = 0; i < 20; i++) {
      small.record({
        hub: 'h',
        method: 'pty.write',
        actor: ACTOR,
        params: { sessionId: `s${i}` },
        result: 'ok'
      })
    }
    expect(statSync(small.filePath).size).toBeLessThanOrEqual(400)
    expect(statSync(`${small.filePath}.1`).size).toBeGreaterThan(0)
    expect(statSync(`${small.filePath}.2`).size).toBeGreaterThan(0)
    expect(() => statSync(`${small.filePath}.3`)).toThrow()
  })

  it('no hub frame names the log, and fs frames cannot read, change or delete it', async () => {
    // Nothing in the contract reads, lists or clears a log.
    for (const method of Object.values(HubToComputerMethods)) {
      expect(method).not.toMatch(/log|audit|history/i)
    }
    // Even with the state dir inside an allowed root (the supervised `[homedir()]`
    // shape), the log and the computer's config are refused to every fs frame.
    const config = configWith([dir])
    const { handle } = dispatchFor(config)
    await handle(HubToComputerMethods.gitIsGitRepo, { path: dir }, ACTOR) // write a line
    const logDir = join(stateDir, REQUEST_LOG_DIR_NAME)
    const attempts: [string, unknown][] = [
      [HubToComputerMethods.fsReadFile, { rootPath: logDir, filePath: 'requests.log' }],
      [
        HubToComputerMethods.fsReadFile,
        { rootPath: stateDir, filePath: 'request-log/requests.log' }
      ],
      [
        HubToComputerMethods.fsWriteFile,
        { rootPath: stateDir, filePath: 'request-log/requests.log', content: '' }
      ],
      [HubToComputerMethods.fsDelete, { rootPath: stateDir, targetPath: REQUEST_LOG_DIR_NAME }],
      [
        HubToComputerMethods.fsRename,
        { rootPath: stateDir, oldPath: REQUEST_LOG_DIR_NAME, newPath: 'x' }
      ],
      [HubToComputerMethods.fsRemoveDir, { path: stateDir }],
      [HubToComputerMethods.fsRemoveDir, { path: dir }],
      [HubToComputerMethods.fsCopyIn, { rootPath: root, absoluteSrc: log.filePath }],
      [
        HubToComputerMethods.fsWriteFile,
        { rootPath: stateDir, filePath: 'computer.config.json', content: '{"allowedRoots":["/"]}' }
      ]
    ]
    for (const [method, params] of attempts) {
      const err = await rejection(handle(method, params, ACTOR))
      expect([method, err.code]).toEqual([method, ComputerTransportErrorCodes.refusedByComputer])
    }
    // A content search above the state dir never returns the log's lines.
    const found = (await handle(
      HubToComputerMethods.fsSearchFiles,
      { rootPath: dir, query: 'git.isGitRepo' },
      ACTOR
    )) as { results: { path: string }[] }
    expect(found.results.filter((r) => r.path.includes(REQUEST_LOG_DIR_NAME))).toEqual([])
    // The log is intact: one line per request above, refusals included.
    expect(logLines().length).toBe(1 + attempts.length + 1)
  })
})

describe('processes start inside the jail', () => {
  it('refuses a proc.spawn and a pty.spawn whose cwd is outside allowedRoots, and logs it', async () => {
    const config = configWith([root])
    const dispatch = dispatchFor(config, { p1: dir })
    try {
      const proc = await rejection(
        dispatch.handle(
          HubToComputerMethods.procSpawn,
          {
            sessionId: 'p-1',
            projectId: 'p1',
            command: '/bin/sh',
            args: ['-c', 'exit 0'],
            cwd: dir
          },
          ACTOR
        )
      )
      expect(proc.code).toBe(ComputerTransportErrorCodes.refusedByComputer)
      const pty = await rejection(
        dispatch.handle(
          HubToComputerMethods.ptyWarmSpawn,
          { warmId: 'w-1', projectId: 'p1', command: '/bin/sh', cwd: '/' },
          ACTOR
        )
      )
      expect(pty.code).toBe(ComputerTransportErrorCodes.refusedByComputer)
      expect(logLines().map((l) => l.result)).toEqual(['refused', 'refused'])
    } finally {
      dispatch.dispose()
    }
  })

  it("starts a cwd-less project spawn in that project's folder; an unplaced project asks to be placed", async () => {
    const project = join(root, 'proj')
    mkdirSync(project)
    const dispatch = dispatchFor(configWith([root]), { p1: project })
    try {
      const out = join(project, 'where.txt')
      const res = (await dispatch.handle(
        HubToComputerMethods.procSpawn,
        { sessionId: 'p-4', projectId: 'p1', command: `pwd > ${out}`, shell: true },
        ACTOR
      )) as { pid: number | null }
      expect(res.pid).not.toBeNull()
      await vi.waitFor(() => expect(readFileSync(out, 'utf8').trim()).toBe(realpathSync(project)))
      const err = await rejection(
        dispatch.handle(
          HubToComputerMethods.procSpawn,
          { sessionId: 'p-5', projectId: 'p2', command: 'pwd', shell: true },
          ACTOR
        )
      )
      expect(err.code).toBe(ComputerTransportErrorCodes.projectNotPlaced)
      // Another project's folder, inside the machine bound: not this spawn's to start in.
      const other = join(root, 'other')
      mkdirSync(other)
      const foreign = await rejection(
        dispatch.handle(
          HubToComputerMethods.procSpawn,
          { sessionId: 'p-6', projectId: 'p1', command: 'pwd', shell: true, cwd: other },
          ACTOR
        )
      )
      expect(foreign.code).toBe(ComputerTransportErrorCodes.refusedByComputer)
      expect(foreign.message).toMatch(/outside the folders of project p1/)
    } finally {
      dispatch.dispose()
    }
  })

  it('refuses a spawn that names no task or project (§9 Phase 7c), cwd or not', async () => {
    const config = configWith([root])
    const dispatch = dispatchFor(config)
    try {
      for (const params of [
        { sessionId: 'p-2', command: 'pwd', shell: true },
        { sessionId: 'p-3', command: 'pwd', shell: true, cwd: root }
      ]) {
        const err = await rejection(dispatch.handle(HubToComputerMethods.procSpawn, params, ACTOR))
        expect(err.code).toBe(ComputerTransportErrorCodes.refusedByComputer)
        expect(err.message).toMatch(/names no task or project/)
      }
    } finally {
      dispatch.dispose()
    }
  })
})

describe('global processes the hub marks as such (B1)', () => {
  it('start as before §9 Phase 7c: cwd judged by the machine bound, none = the first allowed root', async () => {
    const dispatch = dispatchFor(configWith([root]))
    try {
      const sub = join(root, 'sub')
      mkdirSync(sub)
      for (const [sessionId, cwd, expected] of [
        ['g-1', undefined, root],
        ['g-2', sub, sub]
      ] as const) {
        const out = join(root, `${sessionId}.txt`)
        const res = (await dispatch.handle(
          HubToComputerMethods.procSpawn,
          {
            sessionId,
            command: `pwd > ${out}`,
            shell: true,
            global: true,
            ...(cwd ? { cwd } : {})
          },
          ACTOR
        )) as { pid: number | null }
        expect(res.pid).not.toBeNull()
        await vi.waitFor(() =>
          expect(readFileSync(out, 'utf8').trim()).toBe(realpathSync(expected))
        )
      }
      // Outside the machine bound: refused, as before.
      const outside = await rejection(
        dispatch.handle(
          HubToComputerMethods.procSpawn,
          { sessionId: 'g-3', command: 'pwd', shell: true, global: true, cwd: dir },
          ACTOR
        )
      )
      expect(outside.code).toBe(ComputerTransportErrorCodes.refusedByComputer)
    } finally {
      dispatch.dispose()
    }
  })

  it('the marker is only for a spawn naming no task or project, and only for proc.spawn', async () => {
    const project = join(root, 'proj')
    mkdirSync(project)
    const other = join(root, 'other')
    mkdirSync(other)
    const dispatch = dispatchFor(configWith([root]), { p1: project })
    try {
      // A project spawn stays confined to its project, marker or not.
      const foreign = await rejection(
        dispatch.handle(
          HubToComputerMethods.procSpawn,
          {
            sessionId: 'g-4',
            projectId: 'p1',
            command: 'pwd',
            shell: true,
            global: true,
            cwd: other
          },
          ACTOR
        )
      )
      expect(foreign.message).toMatch(/outside the folders of project p1/)
      // A pty spawn naming neither is still refused.
      const pty = await rejection(
        dispatch.handle(
          HubToComputerMethods.ptySpawn,
          { sessionId: 'g-5', command: '/bin/sh', global: true, cwd: root },
          ACTOR
        )
      )
      expect(pty.code).toBe(ComputerTransportErrorCodes.refusedByComputer)
    } finally {
      dispatch.dispose()
    }
  })
})

describe('task processes the hub scopes to their project (B1)', () => {
  it("a task with no worktree and no project id on its row starts in its project's folder", async () => {
    const project = join(root, 'proj')
    mkdirSync(project)
    const dispatch = dispatchFor(configWith([root]), { p1: project })
    try {
      const out = join(project, 'task-where.txt')
      const res = (await dispatch.handle(
        HubToComputerMethods.procSpawn,
        { sessionId: 'p-8', taskId: 't1', command: `pwd > ${out}`, shell: true, cwd: project },
        { ...ACTOR, pathScope: { kind: 'task', taskId: 't1', projectId: 'p1' } }
      )) as { pid: number | null }
      expect(res.pid).not.toBeNull()
      await vi.waitFor(() => expect(readFileSync(out, 'utf8').trim()).toBe(realpathSync(project)))
    } finally {
      dispatch.dispose()
    }
  })
})

describe('chat paths wait for the project folder map (§9 Phase 7c)', () => {
  it('a chat folder list sent while the map is still loading is judged once it loads, not refused', async () => {
    const project = join(root, 'proj')
    mkdirSync(project)
    const deps = projectScopedDeps({ p1: project })
    let loaded = false
    let markReady!: () => void
    const projectPathsReady = new Promise<void>((resolve) => {
      markReady = () => {
        loaded = true
        resolve()
      }
    })
    const dispatch = createHubRequestHandler({
      shutdown: () => {},
      dialer,
      config: configWith([root]),
      requestLog: log,
      hubHost: 'hub.example.com',
      ...deps,
      // At computer boot the map is one async file read away: nothing placed yet.
      getProjectPaths: () => (loaded ? deps.getProjectPaths() : null),
      projectPathsReady
    })
    try {
      const pending = dispatch.handle(
        HubToComputerMethods.chatRequest,
        {
          kind: 'catalog',
          method: 'listFiles',
          args: [project, ''],
          scope: { taskId: 't1', projectId: 'p1' }
        },
        ACTOR
      )
      setTimeout(markReady, 20)
      await expect(pending).resolves.toBeDefined()
    } finally {
      dispatch.dispose()
    }
  })
})

describe('protocol mismatch', () => {
  it('refuses a request with no actor (a pre-v3 hub) and logs it', async () => {
    const { handle } = dispatchFor(configWith([root]))
    for (const actor of [undefined, { route: null }, 'user-1']) {
      const err = await rejection(handle(HubToComputerMethods.gitIsGitRepo, { path: root }, actor))
      expect(err.code).toBe(ComputerTransportErrorCodes.protocolMismatch)
      expect(err.message).toMatch(/upgrade the hub/)
    }
    expect(logLines().map((l) => [l.result, l.actor])).toEqual([
      ['refused', null],
      ['refused', null],
      ['refused', null]
    ])
  })
})
