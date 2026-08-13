import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
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
      /not checked out on this computer/
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
