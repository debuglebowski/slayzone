import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it, vi } from 'vitest'
import { createComputerUpgradeStatusHandler } from './computer-upgrade-status'

it('machine status enforces authorization, payload bounds and per-computer rate', async () => {
  const save = vi.fn(async () => undefined)
  const handler = createComputerUpgradeStatusHandler({
    authorize: async (key) => (key === 'valid' ? 'computer-1' : null),
    save
  })
  const server = createServer((req, res) => {
    if (!handler(req, res)) res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const url = `http://127.0.0.1:${port}/api/computers/upgrade-status`
  const status = {
    phase: 'failed',
    currentVersion: '1.0.0',
    hostVersion: '1.0.0',
    target: '2.0.0',
    error: 'registry unavailable',
    updatedAt: new Date().toISOString()
  }
  const put = (token: string, body = JSON.stringify(status)) =>
    fetch(url, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body
    })
  try {
    expect((await put('revoked')).status).toBe(401)
    expect((await put('valid', 'x'.repeat(16385))).status).toBe(413)
    expect((await put('valid')).status).toBe(204)
    expect(save).toHaveBeenLastCalledWith('computer-1', status)
    expect((await put('valid', '{"phase":"fake"}')).status).toBe(400)
    for (let i = 0; i < 58; i++) await put('valid')
    expect((await put('valid')).status).toBe(429)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
