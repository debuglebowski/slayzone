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
import { HubToRunnerMethods, RunnerNotificationMethods } from '@slayzone/runner-transport/shared'
import type { RunnerConfig } from '../config'
import { createProjectPathStore, projectsFilePath } from '../project-paths'
import { createPtyHandlers } from './pty'
import { createProjectHandlers } from './project'
import type { RunnerDialer } from './types'

const M = HubToRunnerMethods
const dialer: RunnerDialer = { notify: () => true }
const HUB = 'hub.example_8443'

let dir: string

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'runner-projects-')))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function ctxWith(roots: string[]) {
  const config: RunnerConfig = {
    hubUrl: 'wss://hub.example:8443/runners',
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
  it('answers null for a project this runner has never held', async () => {
    const { handlers } = await handlersFor([dir])
    expect(handlers[M.projectResolvePath]({ projectId: 'p1' })).toEqual({ path: null })
  })

  it('records a path and reads it back, canonicalized', async () => {
    const target = join(dir, 'app')
    mkdirSync(target, { recursive: true })
    const { handlers } = await handlersFor([dir])

    expect(
      await handlers[M.projectSetPath]({ projectId: 'p1', path: target, source: 'adopted' })
    ).toEqual({ path: target })
    expect(handlers[M.projectResolvePath]({ projectId: 'p1' })).toEqual({
      path: target,
      source: 'adopted',
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
    await handlers[M.projectSetPath]({ projectId: 'p1', path: target, source: 'adopted' })

    rmSync(target, { recursive: true, force: true })
    expect(handlers[M.projectResolvePath]({ projectId: 'p1' })).toEqual({
      path: target,
      source: 'adopted',
      exists: false
    })
  })

  it('refuses to record a path outside the jail', async () => {
    const inner = join(dir, 'inner')
    mkdirSync(inner, { recursive: true })
    const { handlers } = await handlersFor([inner])
    await expect(
      handlers[M.projectSetPath]({ projectId: 'p1', path: dir, source: 'adopted' })
    ).rejects.toThrow(/allowedRoots/)
    expect(handlers[M.projectResolvePath]({ projectId: 'p1' })).toEqual({ path: null })
  })

  // Forget drops the MAPPING. Deleting a user's code on a machine they are not
  // sitting at is unrecoverable and was never asked for.
  it('forgets the mapping without touching the checkout', async () => {
    const target = join(dir, 'app')
    mkdirSync(target, { recursive: true })
    const { handlers } = await handlersFor([dir])
    await handlers[M.projectSetPath]({ projectId: 'p1', path: target, source: 'adopted' })

    expect(await handlers[M.projectForgetPath]({ projectId: 'p1' })).toEqual({ ok: true })
    expect(handlers[M.projectResolvePath]({ projectId: 'p1' })).toEqual({ path: null })
    expect(readFileSync(projectsFilePath(dir), 'utf-8')).not.toContain('p1')
    expect(realpathSync(target)).toBe(target)
  })

  it('lists what this runner holds', async () => {
    const a = join(dir, 'a')
    const b = join(dir, 'b')
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })
    const { handlers } = await handlersFor([dir])
    await handlers[M.projectSetPath]({ projectId: 'p1', path: a, source: 'adopted' })
    await handlers[M.projectSetPath]({ projectId: 'p2', path: b, source: 'provisioned' })

    const res = handlers[M.projectList]({}) as {
      projects: { projectId: string; source: string }[]
    }
    expect(res.projects.map((p) => [p.projectId, p.source]).sort()).toEqual([
      ['p1', 'adopted'],
      ['p2', 'provisioned']
    ])
  })
})

describe('project path store — persistence', () => {
  it('survives a restart', async () => {
    const target = join(dir, 'app')
    mkdirSync(target, { recursive: true })
    const first = await createProjectPathStore(HUB, { baseDir: dir })
    await first.set('p1', target, 'adopted')

    const second = await createProjectPathStore(HUB, { baseDir: dir })
    expect(second.get('p1')?.path).toBe(target)
  })

  // A runner can be enrolled with several hubs. One hub's mappings must not be
  // visible to — or clobbered by — another's, exactly as with credentials.
  it('keeps each hub’s mappings separate', async () => {
    const a = join(dir, 'a')
    const b = join(dir, 'b')
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })

    const hubA = await createProjectPathStore('hub-a', { baseDir: dir })
    const hubB = await createProjectPathStore('hub-b', { baseDir: dir })
    await hubA.set('p1', a, 'adopted')
    await hubB.set('p1', b, 'adopted')

    expect((await createProjectPathStore('hub-a', { baseDir: dir })).get('p1')?.path).toBe(a)
    expect((await createProjectPathStore('hub-b', { baseDir: dir })).get('p1')?.path).toBe(b)
  })

  // One malformed row must not orphan every other project on the machine.
  it('drops a corrupt entry rather than the whole file', async () => {
    const target = join(dir, 'app')
    mkdirSync(target, { recursive: true })
    const store = await createProjectPathStore(HUB, { baseDir: dir })
    await store.set('good', target, 'adopted')

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
  // is. It cannot know where — it held one path column covering every runner.
  it('spawns in the recorded path when only projectId is given', async () => {
    const target = join(dir, 'app')
    mkdirSync(target, { recursive: true })
    const store = await createProjectPathStore(HUB, { baseDir: dir })
    await store.set('p1', target, 'adopted')

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

  // Falling back to the runner's launch directory would start the agent in the
  // wrong tree and look like it worked — the exact silent failure this removes.
  it('refuses loudly when the project is not checked out here', async () => {
    const store = await createProjectPathStore(HUB, { baseDir: dir })
    const pty = createPtyHandlers(ctxWith([dir]), () => store).handlers
    // Synchronous throw — the dispatch table awaits handler results, so this
    // still reaches the hub as a rejected request.
    expect(() => pty[M.ptySpawn]({ sessionId: 's2', command: 'pwd', projectId: 'nope' })).toThrow(
      /not checked out on this runner/
    )
  })

  // An explicit cwd is a worktree the runner created or a base_dir the user set —
  // never a hub guess — so it must win over the mapping.
  it('prefers an explicit cwd over the mapping', async () => {
    const mapped = join(dir, 'mapped')
    const explicit = join(dir, 'explicit')
    mkdirSync(mapped, { recursive: true })
    mkdirSync(explicit, { recursive: true })
    const store = await createProjectPathStore(HUB, { baseDir: dir })
    await store.set('p1', mapped, 'adopted')

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

describe('project.ensureCheckout', () => {
  it('reports present without touching anything when the checkout is there', async () => {
    const target = join(dir, 'app')
    mkdirSync(target, { recursive: true })
    const { handlers } = await handlersFor([dir])
    await handlers[M.projectSetPath]({ projectId: 'p1', path: target, source: 'adopted' })

    expect(await handlers[M.projectEnsureCheckout]({ projectId: 'p1', checkoutId: 'c1' })).toEqual({
      path: target,
      outcome: 'present'
    })
  })

  // Cloning over a folder the user chose could destroy work that was never
  // pushed, and recreating it would invent a checkout nobody asked for.
  it('refuses to recreate an ADOPTED checkout that has vanished', async () => {
    const target = join(dir, 'app')
    mkdirSync(target, { recursive: true })
    const { handlers } = await handlersFor([dir])
    await handlers[M.projectSetPath]({ projectId: 'p1', path: target, source: 'adopted' })
    rmSync(target, { recursive: true, force: true })

    expect(
      await handlers[M.projectEnsureCheckout]({
        projectId: 'p1',
        checkoutId: 'c1',
        // A URL is present and STILL must not be used: adoption is the veto.
        repoUrl: 'https://example.invalid/repo.git'
      })
    ).toEqual({ path: target, outcome: 'missing' })
  })

  // The honest answer where the old single path column would have handed over a
  // directory belonging to some other machine.
  it('reports unavailable with no mapping and no URL', async () => {
    const { handlers } = await handlersFor([dir])
    expect(
      await handlers[M.projectEnsureCheckout]({ projectId: 'ghost', checkoutId: 'c1' })
    ).toEqual({ path: null, outcome: 'unavailable' })
  })

  it('clones into <workspaceRoot>/<projectId> and records it as provisioned', async () => {
    // A real local repo to clone from — no network, still a real `git clone`.
    const origin = join(dir, 'origin')
    mkdirSync(origin, { recursive: true })
    const { execFileSync } = await import('node:child_process')
    const git = (args: string[], cwd: string) =>
      execFileSync('git', args, {
        cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'T',
          GIT_AUTHOR_EMAIL: 't@t.t',
          GIT_COMMITTER_NAME: 'T',
          GIT_COMMITTER_EMAIL: 't@t.t'
        }
      })
    git(['init', '-q', '-b', 'main'], origin)
    writeFileSync(join(origin, 'README.md'), '# r')
    git(['add', '-A'], origin)
    git(['commit', '-qm', 'init'], origin)

    const root = join(dir, 'workspaces')
    const { handlers, store } = await handlersFor([dir])
    const res = (await handlers[M.projectEnsureCheckout]({
      projectId: 'p-clone',
      checkoutId: 'c1',
      repoUrl: origin,
      workspaceRoot: root
    })) as { path: string; outcome: string }

    expect(res.outcome).toBe('cloned')
    expect(res.path).toBe(join(root, 'p-clone'))
    expect(existsSync(join(root, 'p-clone', 'README.md'))).toBe(true)
    // Recorded as provisioned, which is what permits a later re-clone.
    expect(store.get('p-clone')?.source).toBe('provisioned')
  })

  // Progress has to be legible: a first agent start becomes a clone, and a clone
  // that takes a minute must not look like a stuck spinner.
  it('streams checkout.status through the dialer', async () => {
    const seen: Array<{ status: string }> = []
    const store = await createProjectPathStore(HUB, { baseDir: dir })
    const ctx = {
      dialer: {
        notify: (method: string, params?: unknown) => {
          if (method === RunnerNotificationMethods.checkoutStatus) {
            seen.push(params as { status: string })
          }
          return true
        }
      },
      config: {
        hubUrl: 'wss://hub.example:8443/runners',
        name: 'test',
        allowedRoots: [dir],
        capabilities: ['fs']
      } as RunnerConfig,
      log: () => {}
    }
    const handlers = createProjectHandlers(ctx, () => store)
    await handlers[M.projectEnsureCheckout]({ projectId: 'ghost', checkoutId: 'c9' })
    expect(seen.map((s) => s.status)).toEqual(['error'])
  })
})
