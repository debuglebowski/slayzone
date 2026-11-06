/**
 * Round-7 N3: a subscription stopped while the procedure's async middlewares still
 * ran (the client unsubscribed within a few ms — a tab switch) was never stopped.
 * tRPC's websocket handler looked the id up for `subscription.stop` only in the map
 * it fills AFTER `await callProcedure`, so the stop was dropped and the observable
 * subscribed anyway, its listener alive until the socket closed. A leaked
 * `pty.onData` keeps a session watched (its relay on) for as long as the window is
 * open. Patched: patches/@trpc__server@11.19.0.patch.
 *
 * The real `applyWSSHandler` and a raw JSON-RPC client; the procedure's middleware
 * awaits like the hub's auth and security-context middlewares do.
 */
import type { AddressInfo } from 'node:net'
import { initTRPC } from '@trpc/server'
import { applyWSSHandler } from '@trpc/server/adapters/ws'
import { observable } from '@trpc/server/observable'
import { afterAll, expect, test } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'

const t = initTRPC.create()
let live = 0
let released: (() => void) | null = null
const gate = () => new Promise<void>((r) => (released = r))
const slowMiddleware = t.middleware(async ({ next }) => {
  await gate()
  return next()
})
const appRouter = t.router({
  watch: t.procedure.use(slowMiddleware).subscription(() =>
    observable<number>(() => {
      live++
      return () => {
        live--
      }
    })
  )
})

const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
const handler = applyWSSHandler({ wss, router: appRouter })
afterAll(async () => {
  handler.broadcastReconnectNotification()
  await new Promise<void>((r) => wss.close(() => r()))
})

const settle = () => new Promise((r) => setTimeout(r, 30))

test('a subscription stopped during its middlewares never subscribes', async () => {
  const { port } = wss.address() as AddressInfo
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise((r) => ws.once('open', r))
  const replies: unknown[] = []
  ws.on('message', (m) => replies.push(JSON.parse(String(m))))
  try {
    for (let id = 1; id <= 20; id++) {
      ws.send(
        JSON.stringify({ id, method: 'subscription', params: { path: 'watch', input: undefined } })
      )
      await settle()
      // Stopped while the middleware still awaits.
      ws.send(JSON.stringify({ id, method: 'subscription.stop' }))
      await settle()
      released?.()
      await settle()
    }
    expect(live, 'listeners still attached after every subscription was stopped').toBe(0)
  } finally {
    ws.close()
  }
})

// Round-8 P3: a stop in the SAME tick as its subscribe (the client unsubscribing at
// once — ws delivers both messages in one read) landed before the handler had even
// started on the subscribe, and was dropped just the same.
test('a stop sent right after its subscribe (same tick) never subscribes', async () => {
  const { port } = wss.address() as AddressInfo
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise((r) => ws.once('open', r))
  try {
    for (let id = 1; id <= 20; id++) {
      ws.send(JSON.stringify({ id, method: 'subscription', params: { path: 'watch' } }))
      ws.send(JSON.stringify({ id, method: 'subscription.stop' }))
      await settle()
      released?.()
      await settle()
    }
    expect(live, 'listeners still attached after back-to-back subscribe + stop').toBe(0)
  } finally {
    ws.close()
  }
})

// Both orders in one batch: a stop BEFORE its subscribe (out of order, or a client
// bug) stops nothing that runs later — the subscription still starts and ends.
test('a subscribe after an unknown stop still subscribes and can be stopped', async () => {
  const { port } = wss.address() as AddressInfo
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise((r) => ws.once('open', r))
  try {
    ws.send(JSON.stringify({ id: 7, method: 'subscription.stop' }))
    ws.send(JSON.stringify({ id: 7, method: 'subscription', params: { path: 'watch' } }))
    await settle()
    released?.()
    await settle()
    expect(live).toBe(1)
    ws.send(JSON.stringify({ id: 7, method: 'subscription.stop' }))
    await settle()
    expect(live).toBe(0)
  } finally {
    ws.close()
  }
})

test('one stopped after it started still ends (unchanged)', async () => {
  const { port } = wss.address() as AddressInfo
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise((r) => ws.once('open', r))
  try {
    ws.send(JSON.stringify({ id: 1, method: 'subscription', params: { path: 'watch' } }))
    await settle()
    released?.()
    await settle()
    expect(live).toBe(1)
    ws.send(JSON.stringify({ id: 1, method: 'subscription.stop' }))
    await settle()
    expect(live).toBe(0)
  } finally {
    ws.close()
  }
})
