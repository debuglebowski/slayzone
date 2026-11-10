import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { expect, it, vi } from 'vitest'
import { startLoopbackHub } from '../../../domains/computer-transport/src/testing/loopback'
import { placeTestProject } from './project-scope.fixture'

it('defers a rebuilt same-version host until work stops, including with auto-upgrade disabled', async () => {
  vi.stubGlobal('__SLAYZONE_COMPUTER_VERSION__', '1.0.0')
  vi.stubGlobal('__SLAYZONE_COMPUTER_BUILD_ID__', 'loaded-host-build')
  const { startSessionHost, hostControl, connectorHost } = await import('./session-host')
  const { superviseUpgrades } = await import('./upgrade-runtime')
  const root = mkdtempSync(join(tmpdir(), 'same-version-host-build-'))
  const require = createRequire(import.meta.url)
  symlinkSync(
    dirname(dirname(require.resolve('node-pty/package.json'))),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  const original = { entry: join(root, 'computer.cjs'), version: '1.0.0' }
  const source = readFileSync(resolve(import.meta.dirname, '../dist/bin.cjs'), 'utf8')
    .replace(/var COMPUTER_VERSION = [^;]+;/, 'var COMPUTER_VERSION = "1.0.0";')
    .replace(/var COMPUTER_BUILD_ID = [^;]+;/, 'var COMPUTER_BUILD_ID = "rebuilt-same-version";')
  expect(source).toContain('var COMPUTER_BUILD_ID = "rebuilt-same-version";')
  writeFileSync(original.entry, source)
  const hub = await startLoopbackHub({ floodLimits: false })
  const config = {
    hubUrl: hub.url,
    name: 'same-version-build',
    allowedRoots: [root],
    capabilities: ['proc'],
    joinToken: 'jt-valid',
    autoUpgrade: false
  }
  const previousRoot = process.env.SLAYZONE_ROOT
  process.env.SLAYZONE_ROOT = root
  placeTestProject(root, config.hubUrl, 'p1', root)
  const host = await startSessionHost(root, config)
  const control = await hostControl(root)
  const grant = await control.rpc.request<import('./session-host').ConnectorGrant>('reserve', {
    hubUrl: hub.url
  })
  const native = await connectorHost(root, grant, hub.url, {})
  await native.rpc.request('dispatch', {
    method: 'proc.spawn',
    actor: { userId: null, route: null },
    params: {
      sessionId: 'active',
      projectId: 'p1',
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      cwd: root
    }
  })
  const argvLength = process.argv.length
  process.argv.push('--supervisor')
  const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw Error('test supervisor exit ' + code)
  })
  let supervisor: Awaited<ReturnType<typeof superviseUpgrades>> | undefined
  try {
    supervisor = await superviseUpgrades(config, original, root, () => {}, { intervalMs: 50 })
    await vi.waitFor(() => expect(hub.gateway.listComputers()).toHaveLength(1), { timeout: 10_000 })
    expect(hub.gateway.listComputers()[0].chatRuntimeReady).toBe(true)
    expect(await control.rpc.request('health')).toMatchObject({
      idle: false,
      buildId: 'loaded-host-build',
      version: '1.0.0'
    })
    expect(exit).not.toHaveBeenCalled()
    const key = new URL(hub.url).host.replace(/[^a-zA-Z0-9.-]/g, '_')
    await vi.waitFor(() =>
      expect(
        JSON.parse(
          readFileSync(join(root, 'computer-runtime/hubs', key, 'upgrade-status.json'), 'utf8')
        ).maintenanceReason
      ).toBe('Session host update waits for running work to finish')
    )
    await hub.gateway.request(hub.gateway.listComputers()[0].computerId, 'proc.kill', {
      sessionId: 'active'
    })
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(75), { timeout: 10_000 })
    expect(
      JSON.parse(readFileSync(join(root, 'computer-runtime/host-release.json'), 'utf8')).current
    ).toEqual(original)
  } finally {
    await supervisor?.stop(false)
    await host.stop()
    native.close()
    control.close()
    process.argv.length = argvLength
    exit.mockRestore()
    vi.unstubAllGlobals()
    if (previousRoot === undefined) delete process.env.SLAYZONE_ROOT
    else process.env.SLAYZONE_ROOT = previousRoot
    await hub.close()
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
