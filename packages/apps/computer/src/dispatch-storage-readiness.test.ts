import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { readFileSync, symlinkSync } from 'node:fs'
import { build } from 'esbuild'
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

test
  .skipIf(process.platform === 'win32')
  .each([
    'dispatch-storage-readiness',
    'dispatch-network-controls',
    'dispatch-network-controls-codex',
    'dispatch-network-controls-public',
    'dispatch-network-controls-public-codex'
  ])(
  '%s: real native sync leaves authorized scoped controls responsive across actual online hubs',
  (proof) => nativeProof(proof)
)

test.skipIf(process.platform === 'win32').each([
  ['lost', 'claude-chat'],
  ['late', 'codex-chat'],
  ['exit', 'claude-chat'],
  ['concurrent', 'claude-chat']
])(
  'public controls R1 %s / %s',
  async (scenario, mode) =>
    nativeProof(
      'dispatch-network-controls-public' + (mode === 'codex-chat' ? '-codex' : ''),
      scenario
    ),
  45000
)

async function nativeProof(proof: string, lifetimeCase?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dispatch-native-owner-')))
  try {
    const require = createRequire(import.meta.url)
    const extension = join(root, process.platform === 'darwin' ? 'syncprobe.dylib' : 'syncprobe.so')
    const source = fileURLToPath(
      new URL('../../../domains/chat-runtime/src/server/storage-fence.syncprobe.c', import.meta.url)
    )
    const ccArgv = [
      '-std=c11',
      ...(process.platform === 'darwin' ? ['-dynamiclib'] : ['-shared', '-fPIC']),
      '-O2',
      '-pthread',
      '-I',
      fileURLToPath(
        new URL('../../../../node_modules/better-sqlite3/deps/sqlite3', import.meta.url)
      ),
      source,
      '-o',
      extension
    ]
    const compileStarted = performance.now()
    execFileSync('cc', ccArgv)
    const nativeCompileMs = performance.now() - compileStarted
    const fixture = join(root, 'dispatch.cjs')
    symlinkSync(
      new URL('../../../../node_modules', import.meta.url),
      join(root, 'node_modules'),
      'dir'
    )
    const bundleStarted = performance.now()
    await build({
      entryPoints: [
        fileURLToPath(
          new URL(
            `./${proof.startsWith('dispatch-network-controls') ? 'dispatch-network-controls' : proof}.native.fixture.ts`,
            import.meta.url
          )
        )
      ],
      outfile: fixture,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      external: ['better-sqlite3', 'node-pty', 'node-datachannel', 'bufferutil', 'utf-8-validate'],
      logLevel: 'silent',
      plugins: [
        {
          name: 'native-dispatch-fixture',
          setup(build) {
            build.onResolve({ filter: /\?raw$/ }, (args) => ({
              path: require.resolve(args.path.slice(0, -4), { paths: [args.resolveDir] }),
              namespace: 'raw'
            }))
            build.onLoad({ filter: /.*/, namespace: 'raw' }, async (args) => ({
              contents: await (await import('node:fs/promises')).readFile(args.path, 'utf8'),
              loader: 'text'
            }))
            // Actual packaged worker; fixture bundles only the host/controller dispatch.
            build.onLoad({ filter: /computer-worker-entry\.ts$/ }, () => ({
              contents: `export function computerStorageWorkerEntry() {return ${JSON.stringify(fileURLToPath(new URL('../dist/bin.cjs', import.meta.url)))}}`,
              loader: 'ts'
            }))
          }
        }
      ]
    })
    const fixtureBundleMs = performance.now() - bundleStarted
    const nativeArgv = [
      '--require',
      proof.startsWith('dispatch-network-controls')
        ? fileURLToPath(new URL('./dispatch-network-controls.preload.fixture.cjs', import.meta.url))
        : fileURLToPath(
            new URL(
              '../../../domains/chat-runtime/src/server/computer-online-no-main-sqlite.fixture.cjs',
              import.meta.url
            )
          ),
      fixture,
      root,
      extension,
      proof.endsWith('-codex') ? 'codex-chat' : 'claude-chat'
    ]
    const childStarted = performance.now()
    const output = execFileSync(process.execPath, nativeArgv, {
      encoding: 'utf8',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        SLAYZONE_TEST_CONTROL_SYNC_EXTENSION: extension,
        ...(proof.includes('-public') ? { SLAYZONE_TEST_PUBLIC_CONTROLS: '1' } : {}),
        ...(lifetimeCase ? { SLAYZONE_TEST_CONTROL_LIFETIME_CASE: lifetimeCase } : {})
      },
      timeout: lifetimeCase ? 45000 : 25000
    })
    const nativeChildMs = performance.now() - childStarted
    const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
    const evidence = {
      ...JSON.parse(output),
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      electron: process.versions.electron,
      timings: { nativeCompileMs, fixtureBundleMs, nativeChildMs },
      ccArgv: ['cc', ...ccArgv],
      nativeArgv: [process.execPath, ...nativeArgv],
      sha256: {
        vfsSource: hash(source),
        vfsBinary: hash(extension),
        fixtureBundle: hash(fixture),
        workerBundle: hash(fileURLToPath(new URL('../dist/bin.cjs', import.meta.url)))
      }
    }
    process.stdout.write('POSIX native dispatch proof ' + JSON.stringify(evidence) + '\n')
    if (lifetimeCase) {
      expect(JSON.parse(output)).toMatchObject({
        r1Case: lifetimeCase,
        recovered: true,
        actualPublicCaller: true,
        losslessEvents: 1200,
        mainSyncs: 0
      })
      return
    }
    expect(JSON.parse(output)).toMatchObject({
      actualDispatch: true,
      actualOnlineRuntime: true,
      packagedWorker: true,
      multiHub: true,
      actorChecked: true,
      scopedPingAndPhysicalStopWhileNativeSyncBlocked: true,
      freshFilesystemWaited: true,
      mainSyncs: 0
    })
    if (proof.includes('-public'))
      expect(JSON.parse(output)).toMatchObject({
        actualPublicCaller: true,
        promptRestored: true,
        queueFencePreserved: true,
        singleProviderInterrupt: true,
        durableReceiptReplay: true,
        publicKillRemove: true,
        publicLosslessEvents: 1200,
        replacementFenced: true,
        reconnectFenced: true,
        deletionFenced: true,
        isolatedHubMetadataOnMain: true,
        computerNativeConstructorsRefused: true,
        computerMainNativeCalls: 0
      })
    else
      expect(JSON.parse(output)).toMatchObject({
        mainConstructorsRefused: true,
        mainNativeCalls: 0
      })
    if (proof.startsWith('dispatch-network-controls'))
      expect(JSON.parse(output)).toMatchObject({
        actualNetwork: true,
        authenticatedEnrollment: true,
        providerCancelAcknowledged: true,
        unrelatedHubWrite: true,
        losslessEvents: 1200
      })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
