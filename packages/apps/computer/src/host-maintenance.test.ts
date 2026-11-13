import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it, vi } from 'vitest'
import { HOST_CONTRACT_VERSION } from '@slayzone/computer-runtime'
import { startLoopbackHub } from '../../../domains/computer-transport/src/testing/loopback'
import { placeTestProject } from './project-scope.fixture'

it('discards an incompatible release canceled by the hub before idle maintenance', async () => {
  vi.stubGlobal('__SLAYZONE_COMPUTER_VERSION__', '1.0.0')
  const { startSessionHost, hostControl, connectorHost } = await import('./session-host')
  const { superviseUpgrades, releaseEntry } = await import('./upgrade-runtime')
  const root = mkdtempSync(join(tmpdir(), 'abandoned-host-release-'))
  const require = createRequire(import.meta.url)
  symlinkSync(
    dirname(dirname(require.resolve('node-pty/package.json'))),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  const original = { entry: join(root, 'old.cjs'), version: '1.0.0' }
  writeFileSync(
    original.entry,
    readFileSync(resolve(import.meta.dirname, '../dist/bin.cjs'), 'utf8').replace(
      /var COMPUTER_VERSION = [^;]+;/,
      'var COMPUTER_VERSION = "1.0.0";'
    )
  )
  const runtime = join(root, 'computer-runtime'),
    candidate = releaseEntry(runtime, '2.0.0')
  mkdirSync(dirname(candidate), { recursive: true })
  writeFileSync(
    candidate,
    `if(process.argv.includes('--upgrade-probe'))process.stdout.write('2.0.0');else if(process.argv.includes('--runtime-contract'))process.stdout.write(JSON.stringify({min:${HOST_CONTRACT_VERSION + 1},max:${HOST_CONTRACT_VERSION + 1}}));else process.exit(1)`
  )
  writeFileSync(join(runtime, 'supervisor.json'), JSON.stringify({ current: original }))
  let release = '1.0.0'
  const server = http.createServer((_req, res) =>
    res.end(JSON.stringify({ ok: true, version: release }))
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const hub = await startLoopbackHub({ floodLimits: false }, { server })
  const { port } = server.address() as AddressInfo
  const config = {
    hubUrl: `ws://127.0.0.1:${port}/computers`,
    name: 'maintenance-test',
    allowedRoots: [root],
    capabilities: ['proc'],
    joinToken: 'jt-valid'
  }
  writeFileSync(
    join(root, 'computer.config.json'),
    JSON.stringify({ hubUrl: config.hubUrl, computerName: config.name, allowedRoots: [root] })
  )
  const oldRoot = process.env.SLAYZONE_ROOT
  process.env.SLAYZONE_ROOT = root
  placeTestProject(root, config.hubUrl, 'p1', root)
  const host = await startSessionHost(root, config),
    control = await hostControl(root)
  const grant = await control.rpc.request<import('./session-host').ConnectorGrant>('reserve', {
    hubUrl: config.hubUrl
  })
  const connector = await connectorHost(root, grant, config.hubUrl, {})
  await connector.rpc.request('dispatch', {
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
    throw Error('unexpected exit ' + code)
  })
  let supervisor: Awaited<ReturnType<typeof superviseUpgrades>> | undefined
  const status = () =>
    JSON.parse(
      readFileSync(join(runtime, 'hubs', `127.0.0.1_${port}`, 'upgrade-status.json'), 'utf8')
    )
  try {
    supervisor = await superviseUpgrades(config, original, root, () => {}, {
      probationMs: 0,
      intervalMs: 50
    })
    await vi.waitFor(() => expect(status().phase).toBe('connected'), { timeout: 10000 })
    release = '2.0.0'
    await vi.waitFor(() => expect(status().phase).toBe('maintenance-required'), { timeout: 10000 })
    release = '1.0.0'
    await vi.waitFor(() => expect(status().phase).toBe('connected'), { timeout: 10000 })
    await hub.gateway.request(hub.gateway.listComputers()[0].computerId, 'proc.kill', {
      sessionId: 'active'
    })
    await vi.waitFor(async () =>
      expect((await control.rpc.request<{ idle: boolean }>('health')).idle).toBe(true)
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(JSON.parse(readFileSync(join(runtime, 'supervisor.json'), 'utf8')).current).toEqual(
      original
    )
    expect((await control.rpc.request<{ epoch: string }>('health')).epoch).toBe(host.epoch)
    expect(exit).not.toHaveBeenCalled()
  } finally {
    await supervisor?.stop(true)
    await host.stop()
    connector.close()
    control.close()
    process.argv.length = argvLength
    exit.mockRestore()
    vi.unstubAllGlobals()
    if (oldRoot === undefined) delete process.env.SLAYZONE_ROOT
    else process.env.SLAYZONE_ROOT = oldRoot
    await hub.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
}, 30000)
