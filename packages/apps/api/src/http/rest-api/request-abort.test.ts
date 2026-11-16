import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { expect, test } from 'vitest'
import { currentRequestAbort } from '@slayzone/platform/request-abort'
import type { SlayzoneDb } from '@slayzone/platform'
import { setAuthGate } from '@slayzone/trpc-server'
import { withOwnerGate } from './owner-routes'

test('REST disconnect aborts carried work; normal response close preserves its completed signal', async () => {
  setAuthGate(() => false)
  const app = express()
  const routes = withOwnerGate(app, {} as SlayzoneDb)
  let heldSignal: AbortSignal | undefined, completedSignal: AbortSignal | undefined
  let entered!: () => void
  const accepted = new Promise<void>((resolve) => {
    entered = resolve
  })
  routes.get('/held', async (_req, res) => {
    heldSignal = currentRequestAbort()
    entered()
    if (!heldSignal) {
      res.end()
      return
    }
    await new Promise<void>((resolve) =>
      heldSignal!.addEventListener('abort', () => resolve(), { once: true })
    )
    res.end()
  })
  routes.get('/completed', (_req, res) => {
    completedSignal = currentRequestAbort()
    res.end('ok')
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const port = (server.address() as AddressInfo).port
  const pending = request({ hostname: '127.0.0.1', port, path: '/held' })
  pending.on('error', () => undefined)
  pending.end()
  try {
    await accepted
    expect(heldSignal).toBeDefined()
    const aborted = new Promise<void>((resolve) =>
      heldSignal!.addEventListener('abort', () => resolve(), { once: true })
    )
    pending.destroy()
    await aborted
    expect(heldSignal!.aborted).toBe(true)
    expect(await (await fetch(`http://127.0.0.1:${port}/completed`)).text()).toBe('ok')
    await new Promise((resolve) => setImmediate(resolve))
    expect(completedSignal).toBeDefined()
    expect(completedSignal!.aborted).toBe(false)
  } finally {
    pending.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})
