import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { HubToComputerMethods } from '@slayzone/computer-transport/shared'
import * as chatHandlers from './handlers/chat-runtime'
import { createHubRequestHandler } from './main'
import type { ScopeJail } from './path-jail'

const actor = {
  userId: 'fixture',
  route: 'storage readiness',
  pathScope: { kind: 'project' as const, projectId: 'p' }
}

test('production dispatch awaits fresh async scope, refuses read failures, and keeps scoped ping/stop independent in each hub', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dispatch-storage-readiness-')))
  const create = chatHandlers.createChatRuntimeHandlers
  const release: Array<() => void> = []
  const scopes: Array<ReturnType<typeof vi.fn>> = []
  const patched = vi.spyOn(chatHandlers, 'createChatRuntimeHandlers').mockImplementation((opts) => {
    const h = create(opts)
    const pending = new Promise<ScopeJail>((resolve) =>
      release.push(() =>
        resolve({ label: 'project p', roots: [root], excluded: [], foreign: [], hostReads: false })
      )
    )
    const read = vi.fn(() => pending)
    scopes.push(read)
    // The next production store is async; a controller must await this contract.
    return { ...h, scopeJail: read }
  })
  const make = (hubScope: string) =>
    createHubRequestHandler({
      stateDir: root,
      hubScope,
      getComputerId: () => 'pc',
      shutdown: () => {},
      dialer: { notify: () => true },
      config: {
        hubUrl: `ws://${hubScope}/computers`,
        name: hubScope,
        allowedRoots: [root],
        capabilities: ['fs', 'proc']
      }
    })
  const a = make('one'),
    b = make('two')
  try {
    for (const h of [a, b])
      await h.handle(
        HubToComputerMethods.procSpawn,
        {
          sessionId: 'owned',
          global: true,
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'],
          cwd: root,
          env: { ELECTRON_RUN_AS_NODE: '1' }
        },
        { userId: 'fixture', route: 'start' }
      )
    let settled = false
    const reading = a.handle(HubToComputerMethods.fsPathExists, { path: root }, actor)
    const observed = reading.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    expect(scopes[0]).toHaveBeenCalledOnce()
    expect(scopes[1]).not.toHaveBeenCalled()
    await expect(a.handle(HubToComputerMethods.ping, {}, actor)).resolves.toBeDefined()
    await a.handle(HubToComputerMethods.procKill, { sessionId: 'owned' }, actor)
    expect(scopes[0]).toHaveBeenCalledOnce()
    expect(scopes[1]).not.toHaveBeenCalled()
    const surviving = await b.handle(
      HubToComputerMethods.procList,
      {},
      { userId: 'fixture', route: 'list' }
    )
    expect(JSON.stringify(surviving)).toContain('owned')
    release[0]()
    await expect(reading).resolves.toBeTruthy()
    await observed
    scopes[0].mockRejectedValueOnce(new Error('fresh authority failed'))
    await expect(
      a.handle(HubToComputerMethods.fsPathExists, { path: root }, actor)
    ).rejects.toThrow('fresh authority failed')
    expect(scopes[0]).toHaveBeenCalledTimes(2)
    await expect(a.handle(HubToComputerMethods.ping, {}, {})).rejects.toThrow(/actor|protocol/i)
  } finally {
    for (const wake of release) wake()
    await Promise.all([a.dispose(), b.dispose()])
    patched.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('path/project readiness does not delay validated controls; a placed project cannot bypass unavailable task authority', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dispatch-scope-fail-closed-')))
  let ready: () => void = () => undefined
  const loading = new Promise<void>((resolve) => {
    ready = resolve
  })
  const { createProjectPathStore } = await import('./project-paths')
  const paths = await createProjectPathStore('hub', { baseDir: root })
  await paths.set('p', root)
  const h = createHubRequestHandler({
    stateDir: root,
    hubScope: 'hub',
    getComputerId: () => null,
    getProjectPaths: () => paths,
    pathReady: loading,
    projectPathsReady: loading,
    shutdown: () => {},
    dialer: { notify: () => true },
    config: {
      hubUrl: 'ws://hub/computers',
      name: 'hub',
      allowedRoots: [root],
      capabilities: ['fs', 'proc']
    }
  })
  try {
    await expect(h.handle(HubToComputerMethods.ping, {}, actor)).resolves.toMatchObject({
      ts: expect.any(Number)
    })
    await expect(
      h.handle(HubToComputerMethods.procKill, { sessionId: 'gone' }, actor)
    ).resolves.toEqual({ ok: true, clean: true })
    ready()
    await expect(
      h.handle(HubToComputerMethods.fsPathExists, { path: root }, actor)
    ).rejects.toThrow(/identity|unavailable/i)
  } finally {
    ready()
    await h.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
