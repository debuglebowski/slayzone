import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { discoverHubRelease } from './upgrade-runtime'
import { loadComputerConfig } from './config'

describe('upgrade recovery discovery', () => {
  it('discovers exact release without opening a computer connection or sending credentials', async () => {
    const server = http.createServer((req, res) => {
      expect(req.url).toBe('/health')
      expect(req.headers.authorization).toBeUndefined()
      res.end(JSON.stringify({ ok: true, version: '0.37.0-beta.2' }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as AddressInfo
      await expect(discoverHubRelease([`ws://127.0.0.1:${port}/computers`])).resolves.toBe(
        '0.37.0-beta.2'
      )
    } finally {
      server.close()
    }
  })

  it('refuses a registry selector or command disguised as a release', async () => {
    const server = http.createServer((_req, res) =>
      res.end(JSON.stringify({ ok: true, version: 'latest --ignore-scripts' }))
    )
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as AddressInfo
      await expect(discoverHubRelease([`ws://127.0.0.1:${port}/computers`])).rejects.toThrow(
        'release'
      )
    } finally {
      server.close()
    }
  })

  it('defaults standalone on, desktop off; respects config and env overrides', () => {
    const env = { SLAYZONE_HUB_ADDRESS: 'localhost:9999' }
    expect(loadComputerConfig(env).autoUpgrade).toBe(true)
    expect(loadComputerConfig({ ...env, SLAYZONE_SUPERVISED: '1' }).autoUpgrade).toBe(false)
    expect(loadComputerConfig(env, { autoUpgrade: false }).autoUpgrade).toBe(false)
    expect(
      loadComputerConfig({ ...env, SLAYZONE_COMPUTER_AUTO_UPGRADE: '1' }, { autoUpgrade: false })
        .autoUpgrade
    ).toBe(true)
    expect(() => loadComputerConfig({ ...env, SLAYZONE_COMPUTER_AUTO_UPGRADE: 'yes' })).toThrow()
  })
})

it('keeps slow status reports ordered and coalesces newer progress', async () => {
  const { createStatusReporter } = await import('./upgrade-runtime')
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const delivered: string[] = []
  const report = createStatusReporter(
    async (status) => {
      if (status.phase === 'checking') await gate
      delivered.push(String(status.phase))
    },
    () => {}
  )
  report({ phase: 'checking' })
  report({ phase: 'installing' })
  report({ phase: 'failed' })
  expect(delivered).toEqual([])
  release()
  const { vi } = await import('vitest')
  await vi.waitFor(() => expect(delivered).toEqual(['checking', 'failed']))
})
