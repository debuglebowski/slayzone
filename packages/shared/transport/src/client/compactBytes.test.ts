// @vitest-environment node
/**
 * Upload bytes go over the wire compactly — but only to a hub that reads them.
 *
 * Plain superjson sends a `Uint8Array` as a JSON number array (~3.6 bytes per
 * byte). A client of the runtime sends it as base64 (`bytes:base64`, 4/3) when
 * the hub's `hub.describe` says `wire.compactBytes`; to an older hub (no field) it
 * sends exactly what it always did, since superjson there throws on a custom value
 * it does not know. Measured on the hub's side of a real socket.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { initTRPC } from '@trpc/server'
import { applyWSSHandler } from '@trpc/server/adapters/ws'
import { WebSocketServer } from 'ws'
import superjson from 'superjson'
import { trpcTransformer } from '@slayzone/trpc-server'
import { createTrpcWsClient } from './runtime'

const MiB = 1024 * 1024

function sampleBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  let seed = 0x2545f491
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    out[i] = seed >>> 16
  }
  return out
}

type Hub = { url: string; frames: number[]; received: Uint8Array[]; close: () => Promise<void> }

/** A hub: `hub.describe` (with or without `wire`) and one upload mutation; records frame sizes. */
async function startHub(opts: {
  compactBytes: boolean
  transformer: 'current' | 'legacy'
}): Promise<Hub> {
  const t = initTRPC.create({
    transformer: opts.transformer === 'current' ? trpcTransformer : superjson
  })
  const received: Uint8Array[] = []
  const router = t.router({
    hub: t.router({
      describe: t.procedure.query(() =>
        opts.compactBytes ? { wire: { compactBytes: true } } : { label: null }
      )
    }),
    artifacts: t.router({
      uploadBlob: t.procedure
        .input((v) => v as { title: string; bytes: Uint8Array })
        .mutation(({ input }) => {
          received.push(input.bytes)
          return {
            size: input.bytes.byteLength,
            plain: Object.getPrototypeOf(input.bytes) === Uint8Array.prototype
          }
        })
    })
  })
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  const frames: number[] = []
  wss.on('connection', (ws) => {
    ws.on('message', (data: Buffer) => frames.push(data.byteLength))
  })
  const handler = applyWSSHandler({ wss, router })
  return {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    frames,
    received,
    close: async () => {
      handler.broadcastReconnectNotification()
      for (const c of wss.clients) c.terminate()
      await new Promise<void>((r) => wss.close(() => r()))
    }
  }
}

type UploadClient = {
  artifacts: {
    uploadBlob: {
      mutate: (i: { title: string; bytes: Uint8Array }) => Promise<{ size: number; plain: boolean }>
    }
  }
}

const open: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of open.splice(0)) await close()
})

async function upload(hub: Hub, bytes: Uint8Array) {
  const { client, wsClient } = createTrpcWsClient({ url: hub.url })
  open.push(async () => wsClient.close())
  const result = await (client as unknown as UploadClient).artifacts.uploadBlob.mutate({
    title: 'x.pdf',
    bytes
  })
  return { result, largestFrame: Math.max(...hub.frames) }
}

describe('compact upload bytes', () => {
  const bytes = sampleBytes(MiB)

  it('to a hub that reads them: 1 MiB goes as one ~1.33 MiB frame and arrives byte-exact', async () => {
    const hub = await startHub({ compactBytes: true, transformer: 'current' })
    open.push(hub.close)
    const { result, largestFrame } = await upload(hub, bytes)
    expect(result).toEqual({ size: MiB, plain: true })
    expect(Buffer.from(hub.received[0]).equals(Buffer.from(bytes))).toBe(true)
    expect(largestFrame).toBeLessThan(Math.ceil((MiB * 4) / 3) + 1024)
  })

  it('to an older hub (no wire field, plain superjson): the number-array frame it always got', async () => {
    const hub = await startHub({ compactBytes: false, transformer: 'legacy' })
    open.push(hub.close)
    const { result, largestFrame } = await upload(hub, bytes)
    expect(result).toEqual({ size: MiB, plain: true })
    expect(Buffer.from(hub.received[0]).equals(Buffer.from(bytes))).toBe(true)
    expect(largestFrame).toBeGreaterThan(3.4 * MiB)
  })
})
