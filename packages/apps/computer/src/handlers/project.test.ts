import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  HubToComputerMethods,
  ComputerNotificationMethods
} from '@slayzone/computer-transport/shared'
import type { ComputerConfig } from '../config'
import { createProjectPathStore, projectsFilePath } from '../project-paths'
import { createPtyHandlers } from './pty'
import { createProjectHandlers } from './project'
import type { ComputerDialer } from './types'

const M = HubToComputerMethods
const dialer: ComputerDialer = { notify: () => true }
const HUB = 'hub.example_8443'

let dir: string

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'computer-projects-')))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function ctxWith(roots: string[]) {
  const config: ComputerConfig = {
    hubUrl: 'wss://hub.example:8443/computers',
    name: 'test',
    allowedRoots: roots,
    capabilities: ['fs']
  }
  return { dialer, config, log: () => {} }
}

async function handlersFor(roots: string[], baseDir = dir) {
  const store = await createProjectPathStore(HUB, { baseDir })
  return { handlers: createProjectHandlers(ctxWith(roots), () => store), store }
}

describe('project path mapping', () => {
  it('holds relocation admission while awaiting the async controller idle check', async () => {
    const source = join(dir, 'before')
    const target = join(dir, 'after')
    mkdirSync(source)
    mkdirSync(target)
    const store = await createProjectPathStore(HUB, { baseDir: dir })
    await store.set('p1', source)
    let release: () => void = () => undefined
    const idle = new Promise<void>((resolve) => {
      release = resolve
    })
    const handlers = createProjectHandlers(ctxWith([dir]), () => store, {
      assertIdle: () => idle,
      remap: () => {}
    })
    const moving = handlers['project.relocate']({
      projectId: 'p1',
      sourcePath: source,
      path: target,
      mode: 'update'
    })
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(store.get('p1')?.path).toBe(source)
      expect(() => handlers.assertRelocationAvailable()).toThrow(/relocation/i)
      release()
      await moving
      expect(store.get('p1')?.path).toBe(target)
    } finally {
      release()
      await moving
    }
  })

  it('repairs nested Git worktrees after the folder was moved manually', async () => {
    const source = join(dir, 'repo')
    const target = join(dir, 'renamed')
    mkdirSync(source)
    const git = (path: string, args: string[]) =>
      execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: 'pipe' })
    git(source, ['init'])
    git(source, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'initial'
    ])
    git(source, ['worktree', 'add', '-b', 'nested', join(source, '.worktrees', 'feature')])
    const { handlers, store } = await handlersFor([dir])
    await store.set('p1', source)
    renameSync(source, target)
    await handlers['project.relocate']({
      projectId: 'p1',
      sourcePath: source,
      path: target,
      mode: 'update'
    })
    expect(git(join(target, '.worktrees', 'feature'), ['status', '--porcelain'])).toBe('')
  })

  it('rejects a move while project work is running, before touching files', async () => {
    const source = join(dir, 'before')
    mkdirSync(source)
    const store = await createProjectPathStore(HUB, { baseDir: dir })
    await store.set('p1', source)
    const handlers = createProjectHandlers(ctxWith([dir]), () => store, {
      assertIdle: () => {
        throw new Error('Stop running terminals')
      },
      remap: () => {}
    })
    await expect(
      handlers['project.relocate']({
        projectId: 'p1',
        sourcePath: source,
        path: join(dir, 'after')
      })
    ).rejects.toThrow('Stop running terminals')
    expect(existsSync(source)).toBe(true)
  })

  it('refuses moving a folder used by a project on another hub', async () => {
    const source = join(dir, 'shared')
    mkdirSync(source)
    const { handlers, store } = await handlersFor([dir])
    await store.set('p1', source)
    const other = await createProjectPathStore('other-hub', { baseDir: dir })
    await other.set('another-project', source)
    await expect(
      handlers['project.relocate']({
        projectId: 'p1',
        sourcePath: source,
        path: join(dir, 'after')
      })
    ).rejects.toThrow(/Another project uses/)
    expect(existsSync(source)).toBe(true)
  })
  it('repairs Git links for sibling and nested worktrees after moving the main checkout', async () => {
    const source = join(dir, 'repo')
    const target = join(dir, 'renamed')
    const sibling = join(dir, 'sibling')
    const nested = join(source, '.worktrees', 'feature')
    mkdirSync(source)
    const git = (path: string, args: string[]) =>
      execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: 'pipe' })
    git(source, ['init'])
    git(source, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'initial'
    ])
    git(source, ['worktree', 'add', '-b', 'sibling', sibling])
    git(source, ['worktree', 'add', '-b', 'nested', nested])
    const { handlers, store } = await handlersFor([dir])
    await store.set('p1', source)
    await handlers['project.relocate']({ projectId: 'p1', sourcePath: source, path: target })
    expect(git(sibling, ['status', '--porcelain'])).toBe('')
    expect(git(join(target, '.worktrees', 'feature'), ['status', '--porcelain'])).toBe('')
    expect(git(target, ['worktree', 'list'])).not.toContain(source)
  })

  it('updates a path after a manual move without moving files', async () => {
    const source = join(dir, 'before')
    const target = join(dir, 'after')
    mkdirSync(source)
    writeFileSync(join(source, 'keep.txt'), 'keep')
    const { handlers, store } = await handlersFor([dir])
    await store.set('p1', source)
    renameSync(source, target)
    await handlers['project.relocate']({
      projectId: 'p1',
      sourcePath: source,
      path: target,
      mode: 'update'
    })
    expect(store.get('p1')?.path).toBe(target)
    expect(
      await handlers['project.relocate']({
        projectId: 'p1',
        sourcePath: source,
        path: target,
        mode: 'update'
      })
    ).toEqual({ path: target })
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('replays an interrupted mapping write after restarting', async () => {
    const source = join(dir, 'before')
    const target = join(dir, 'after')
    mkdirSync(source)
    const store = await createProjectPathStore(HUB, { baseDir: dir })
    await store.set('p1', source)
    const failingStore = {
      ...store,
      set: async () => {
        throw new Error('disk write failed')
      }
    }
    const first = createProjectHandlers(ctxWith([dir]), () => failingStore)
    await expect(
      first['project.relocate']({ projectId: 'p1', sourcePath: source, path: target })
    ).rejects.toThrow('disk write failed')
    expect(existsSync(target)).toBe(true)
    const restarted = await handlersFor([dir])
    await restarted.handlers.recoverRelocation()
    expect(restarted.store.get('p1')?.path).toBe(target)
    expect(existsSync(store.relocationFilePath!)).toBe(false)
  })
  it('moves a folder and preserves its project mapping', async () => {
    const source = join(dir, 'before')
    const target = join(dir, 'after')
    mkdirSync(source)
    writeFileSync(join(source, 'uncommitted.txt'), 'keep me')
    const { handlers, store } = await handlersFor([dir])
    await store.set('p1', source)
    await handlers['project.relocate']({ projectId: 'p1', sourcePath: source, path: target })
    expect(existsSync(source)).toBe(false)
    expect(readFileSync(join(target, 'uncommitted.txt'), 'utf8')).toBe('keep me')
    expect(store.get('p1')?.path).toBe(target)
  })

  it('refuses an occupied destination without changing either folder', async () => {
    const source = join(dir, 'before')
    const target = join(dir, 'after')
    mkdirSync(source)
    mkdirSync(target)
    const { handlers, store } = await handlersFor([dir])
    await store.set('p1', source)
    await expect(
      handlers['project.relocate']({ projectId: 'p1', sourcePath: source, path: target })
    ).rejects.toThrow(/already exists/)
    expect(store.get('p1')?.path).toBe(source)
    expect(existsSync(source)).toBe(true)
  })

  it('refuses a stale source and a destination outside allowed roots', async () => {
    const source = join(dir, 'before')
    mkdirSync(source)
    const { handlers, store } = await handlersFor([source])
    await store.set('p1', source)
    await expect(
      handlers['project.relocate']({
        projectId: 'p1',
        sourcePath: join(dir, 'stale'),
        path: join(source, 'new')
      })
    ).rejects.toThrow(/changed/)
    await expect(
      handlers['project.relocate']({
        projectId: 'p1',
        sourcePath: source,
        path: join(dir, 'outside')
      })
    ).rejects.toThrow(/allowedRoots/)
    expect(existsSync(source)).toBe(true)
  })
  // The state the hub's single `projects.path` column could never express: it
  // always had *a* path, even for a machine that had never seen the project.
  it('answers null for a project this computer has never held', async () => {
    const { handlers } = await handlersFor([dir])
    expect(handlers[M.projectResolvePath]({ projectId: 'p1' })).toEqual({ path: null })
  })

  it('records a path and reads it back, canonicalized', async () => {
    const target = join(dir, 'app')
    mkdirSync(target, { recursive: true })
    const { handlers } = await handlersFor([dir])

    expect(await handlers[M.projectSetPath]({ projectId: 'p1', path: target })).toEqual({
      path: target
    })
    expect(handlers[M.projectResolvePath]({ projectId: 'p1' })).toEqual({
      path: target,
      exists: true
    })
  })

  // A recorded path whose folder is gone is NOT the same as no mapping — the
  // first is something to re-point or re-clone, the second is a project this
  // machine has simply never held. Collapsing them hides a moved folder.
  it('distinguishes a vanished checkout from an absent mapping', async () => {
    const target = join(dir, 'app')
    mkdirSync(target, { recursive: true })
    const { handlers } = await handlersFor([dir])
    await handlers[M.projectSetPath]({ projectId: 'p1', path: target })

    rmSync(target, { recursive: true, force: true })
    expect(handlers[M.projectResolvePath]({ projectId: 'p1' })).toEqual({
      path: target,
      exists: false
    })
  })

  it('refuses to record a path outside the jail', async () => {
    const inner = join(dir, 'inner')
    mkdirSync(inner, { recursive: true })
    const { handlers } = await handlersFor([inner])
    await expect(handlers[M.projectSetPath]({ projectId: 'p1', path: dir })).rejects.toThrow(
      /allowedRoots/
    )
    expect(handlers[M.projectResolvePath]({ projectId: 'p1' })).toEqual({ path: null })
  })

  // Forget drops the MAPPING. Deleting a user's code on a machine they are not
  // sitting at is unrecoverable and was never asked for.
  it('forgets the mapping without touching the checkout', async () => {
    const target = join(dir, 'app')
    mkdirSync(target, { recursive: true })
    const { handlers } = await handlersFor([dir])
    await handlers[M.projectSetPath]({ projectId: 'p1', path: target })

    expect(await handlers[M.projectForgetPath]({ projectId: 'p1' })).toEqual({ ok: true })
    expect(handlers[M.projectResolvePath]({ projectId: 'p1' })).toEqual({ path: null })
    expect(readFileSync(projectsFilePath(dir), 'utf-8')).not.toContain('p1')
    expect(realpathSync(target)).toBe(target)
  })

  it('lists what this computer holds', async () => {
    const a = join(dir, 'a')
    const b = join(dir, 'b')
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })
    const { handlers } = await handlersFor([dir])
    await handlers[M.projectSetPath]({ projectId: 'p1', path: a })
    await handlers[M.projectSetPath]({ projectId: 'p2', path: b })

    const res = handlers[M.projectList]({}) as {
      projects: { projectId: string }[]
    }
    expect(res.projects.map((p) => p.projectId).sort()).toEqual(['p1', 'p2'])
  })
})

describe('project clone', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const originRepo = () => {
    const origin = join(dir, 'origin.git')
    mkdirSync(origin)
    git(origin, 'init', '--bare', '-q')
    const seed = join(dir, 'seed')
    mkdirSync(seed)
    git(seed, 'init', '-q')
    git(seed, 'config', 'user.email', 't@example.com')
    git(seed, 'config', 'user.name', 'T')
    git(seed, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(seed, 'code'), 'original')
    git(seed, 'add', '.')
    git(seed, 'commit', '-qm', 'initial')
    git(seed, 'remote', 'add', 'origin', origin)
    git(seed, 'push', '-q', 'origin', 'HEAD')
    return { origin, seed }
  }

  it("reports the project folder's origin, null without a folder or remote", async () => {
    const { origin, seed } = originRepo()
    const { handlers, store } = await handlersFor([dir])
    expect(await handlers[M.projectOrigin]({ projectId: 'p1' })).toEqual({ url: null })
    await store.set('p1', seed)
    expect(await handlers[M.projectOrigin]({ projectId: 'p1' })).toEqual({ url: origin })
    git(seed, 'remote', 'remove', 'origin')
    expect(await handlers[M.projectOrigin]({ projectId: 'p1' })).toEqual({ url: null })
  })

  it('clones into the folder and records it as the project folder', async () => {
    const { origin } = originRepo()
    const { handlers, store } = await handlersFor([dir])
    const target = join(dir, 'clones', 'project')
    expect(await handlers[M.projectClone]({ projectId: 'p1', path: target, url: origin })).toEqual({
      path: target
    })
    expect(readFileSync(join(target, 'code'), 'utf8')).toBe('original')
    expect(store.get('p1')?.path).toBe(target)
  })

  it('never clones into a folder that holds anything, nor outside the jail', async () => {
    const { origin } = originRepo()
    const { handlers, store } = await handlersFor([join(dir, 'allowed')])
    mkdirSync(join(dir, 'allowed', 'busy'), { recursive: true })
    writeFileSync(join(dir, 'allowed', 'busy', 'keep'), 'keep')
    await expect(
      handlers[M.projectClone]({ projectId: 'p1', path: join(dir, 'allowed', 'busy'), url: origin })
    ).rejects.toThrow(/not empty/)
    await expect(
      handlers[M.projectClone]({ projectId: 'p1', path: join(dir, 'outside'), url: origin })
    ).rejects.toThrow()
    expect(existsSync(join(dir, 'outside'))).toBe(false)
    expect(store.get('p1')).toBeNull()
  })

  it('refuses option-like and ext:: urls', async () => {
    const { handlers } = await handlersFor([dir])
    for (const url of ['--upload-pack=touch /tmp/x', 'ext::sh -c touch% /tmp/x'])
      await expect(
        handlers[M.projectClone]({ projectId: 'p1', path: join(dir, 'x'), url })
      ).rejects.toThrow()
    expect(existsSync(join(dir, 'x'))).toBe(false)
  })
})

describe('project path store — persistence', () => {
  it('survives a restart', async () => {
    const target = join(dir, 'app')
    mkdirSync(target, { recursive: true })
    const first = await createProjectPathStore(HUB, { baseDir: dir })
    await first.set('p1', target)

    const second = await createProjectPathStore(HUB, { baseDir: dir })
    expect(second.get('p1')?.path).toBe(target)
  })

  // A computer can be enrolled with several hubs. One hub's mappings must not be
  // visible to — or clobbered by — another's, exactly as with credentials.
  it('keeps each hub’s mappings separate', async () => {
    const a = join(dir, 'a')
    const b = join(dir, 'b')
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })

    const hubA = await createProjectPathStore('hub-a', { baseDir: dir })
    const hubB = await createProjectPathStore('hub-b', { baseDir: dir })
    await hubA.set('p1', a)
    await hubB.set('p1', b)

    expect((await createProjectPathStore('hub-a', { baseDir: dir })).get('p1')?.path).toBe(a)
    expect((await createProjectPathStore('hub-b', { baseDir: dir })).get('p1')?.path).toBe(b)
  })

  // One malformed row must not orphan every other project on the machine.
  it('drops a corrupt entry rather than the whole file', async () => {
    const target = join(dir, 'app')
    mkdirSync(target, { recursive: true })
    const store = await createProjectPathStore(HUB, { baseDir: dir })
    await store.set('good', target)

    const file = projectsFilePath(dir)
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
    ;(raw[HUB] as Record<string, unknown>).bad = { path: 42 }
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, JSON.stringify(raw))

    const reloaded = await createProjectPathStore(HUB, { baseDir: dir })
    expect(reloaded.get('good')?.path).toBe(target)
    expect(reloaded.get('bad')).toBeNull()
  })
})

describe('a spawn with no cwd resolves the project’s own checkout', () => {
  // The point of the whole inversion: the hub sends WHICH project, not WHERE it
  // is. It cannot know where — it held one path column covering every computer.
  it('spawns in the recorded path when only projectId is given', async () => {
    const target = join(dir, 'app')
    mkdirSync(target, { recursive: true })
    const store = await createProjectPathStore(HUB, { baseDir: dir })
    await store.set('p1', target)

    const ctx = ctxWith([dir])
    const pty = createPtyHandlers(ctx, () => store).handlers
    const res = (await pty[M.ptySpawn]({
      sessionId: 's1',
      command: 'pwd',
      projectId: 'p1'
    })) as { pid: number }
    expect(res.pid).toBeGreaterThan(0)
    pty[M.ptyKill]({ sessionId: 's1' })
  })

  // Falling back to the computer's launch directory would start the agent in the
  // wrong tree and look like it worked — the exact silent failure this removes.
  it('refuses loudly when the project is not checked out here', async () => {
    const store = await createProjectPathStore(HUB, { baseDir: dir })
    const pty = createPtyHandlers(ctxWith([dir]), () => store).handlers
    // Synchronous throw — the dispatch table awaits handler results, so this
    // still reaches the hub as a rejected request.
    expect(() => pty[M.ptySpawn]({ sessionId: 's2', command: 'pwd', projectId: 'nope' })).toThrow(
      /has no folder for project/
    )
  })

  // An explicit cwd is a worktree the computer created or a base_dir the user set —
  // never a hub guess — so it must win over the mapping.
  it('prefers an explicit cwd over the mapping', async () => {
    const mapped = join(dir, 'mapped')
    const explicit = join(dir, 'explicit')
    mkdirSync(mapped, { recursive: true })
    mkdirSync(explicit, { recursive: true })
    const store = await createProjectPathStore(HUB, { baseDir: dir })
    await store.set('p1', mapped)

    const pty = createPtyHandlers(ctxWith([dir]), () => store).handlers
    const res = (await pty[M.ptySpawn]({
      sessionId: 's3',
      command: 'pwd',
      cwd: explicit,
      projectId: 'p1'
    })) as { pid: number }
    expect(res.pid).toBeGreaterThan(0)
    pty[M.ptyKill]({ sessionId: 's3' })
  })
})
