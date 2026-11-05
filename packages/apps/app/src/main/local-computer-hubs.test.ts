/**
 * The local computer on every remote hub the client lists (`local-computer-hubs.ts`):
 * which hubs it is told to serve, when a join token is minted, what is remembered,
 * and how a failed hub recovers. Pure: the mint, the supervisor and the clock are fakes.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import type { SecondaryHub } from './local-computer-supervisor'
import {
  checkDialUrl,
  createLocalComputerHubs,
  RECOVERY_INTERVAL_MS,
  type RemoteHubEntry
} from './local-computer-hubs'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})

const HUB_B: RemoteHubEntry = { id: 'hub:b', label: 'B', url: 'wss://b.example.com/trpc' }
const HUB_C: RemoteHubEntry = { id: 'hub:c', label: 'C', url: 'wss://c.example.com/trpc' }

function harness(
  opts: { hubs?: RemoteHubEntry[]; failMint?: Set<string>; stateFile?: string } = {}
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-hubs-'))
  dirs.push(dir)
  let hubs = opts.hubs ?? [HUB_B]
  let clock = 1_000_000
  const applied: SecondaryHub[][] = []
  const mints: string[] = []
  const failMint = opts.failMint ?? new Set<string>()
  const stateFile = opts.stateFile ?? path.join(dir, 'hubs.json')
  const hubsApi = createLocalComputerHubs({
    stateFile,
    listRemoteHubs: () => hubs,
    mint: async (hub, label) => {
      mints.push(`${hub.id}:${label}`)
      if (failMint.has(hub.id)) throw new Error(`mint refused on ${hub.label}`)
      return {
        token: `tok-${mints.length}`,
        hubUrl: `wss://${new URL(hub.url).host}/computers`
      }
    },
    computerName: () => 'my-mac',
    primaryHubUrl: () => 'ws://127.0.0.1:5000/computers',
    apply: (set) => applied.push(set),
    log: () => undefined,
    now: () => clock
  })
  return {
    api: hubsApi,
    applied,
    mints,
    stateFile,
    setHubs: (next: RemoteHubEntry[]) => {
      hubs = next
    },
    tick: (ms: number) => {
      clock += ms
    }
  }
}

describe('joining', () => {
  test('a new hub: minted once, joined with the token under this machine’s name', async () => {
    const h = harness()
    await h.api.sync()
    expect(h.mints).toEqual(['hub:b:my-mac'])
    expect(h.applied.at(-1)).toEqual([
      { url: 'wss://b.example.com/computers', name: 'my-mac', joinToken: 'tok-1' }
    ])
    expect(h.api.status()['hub:b']?.state).toBe('joining')

    h.api.onEvent({
      type: 'connected',
      hubUrl: 'wss://b.example.com/computers',
      computerId: 'cid-b'
    })
    expect(h.api.status()['hub:b']).toEqual({ state: 'joined', computerId: 'cid-b', error: null })

    // Joined: a later sync mints nothing and sends no token (the credential is kept).
    await h.api.sync()
    expect(h.mints.length).toBe(1)
    expect(h.applied.at(-1)).toEqual([{ url: 'wss://b.example.com/computers', name: 'my-mac' }])
  })

  test('remembered across restarts: the dial url and the computer id, no new mint', async () => {
    const first = harness()
    await first.api.sync()
    first.api.onEvent({
      type: 'connected',
      hubUrl: 'wss://b.example.com/computers',
      computerId: 'cid-b'
    })
    await new Promise((r) => setTimeout(r, 50))
    const second = harness({ stateFile: first.stateFile })
    await second.api.sync()
    expect(second.mints).toEqual([])
    expect(second.applied.at(-1)).toEqual([
      { url: 'wss://b.example.com/computers', name: 'my-mac' }
    ])
    expect(second.api.status()['hub:b']?.computerId).toBe('cid-b')
  })

  test('a removed hub is left, and forgotten', async () => {
    const h = harness({ hubs: [HUB_B, HUB_C] })
    await h.api.sync()
    expect(h.applied.at(-1)?.map((x) => x.url)).toEqual([
      'wss://b.example.com/computers',
      'wss://c.example.com/computers'
    ])
    h.setHubs([HUB_C])
    await h.api.sync()
    expect(h.applied.at(-1)?.map((x) => x.url)).toEqual(['wss://c.example.com/computers'])
    expect(h.api.status()['hub:b']).toBeUndefined()
  })

  test('a hub that refuses the mint is reported, and the others still join', async () => {
    const h = harness({ hubs: [HUB_B, HUB_C], failMint: new Set(['hub:b']) })
    await h.api.sync()
    expect(h.api.status()['hub:b']).toMatchObject({ state: 'failed', error: 'mint refused on B' })
    expect(h.applied.at(-1)?.map((x) => x.url)).toEqual(['wss://c.example.com/computers'])
  })
})

describe('recovery', () => {
  test('the computer asks for a fresh token: minted on that hub', async () => {
    const h = harness()
    await h.api.sync()
    expect(await h.api.mintFor('wss://b.example.com/computers')).toBe('tok-2')
    expect(await h.api.mintFor('wss://unknown/computers')).toBeNull()
  })

  test('a failed hub is retried with a fresh token, at most once per interval', async () => {
    const h = harness()
    await h.api.sync()
    h.api.onEvent({ type: 'connected', hubUrl: 'wss://b.example.com/computers', computerId: 'c' })
    h.api.onEvent({
      type: 'hub-error',
      hubUrl: 'wss://b.example.com/computers',
      message: 'refused',
      reason: 'needs-re-enrollment'
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(h.mints.length).toBe(2)
    expect(h.applied.at(-1)).toEqual([
      { url: 'wss://b.example.com/computers', name: 'my-mac', joinToken: 'tok-2' }
    ])
    // A second failure inside the window does not mint again.
    h.api.onEvent({ type: 'hub-error', hubUrl: 'wss://b.example.com/computers', message: 'x' })
    await new Promise((r) => setTimeout(r, 20))
    expect(h.mints.length).toBe(2)
    h.tick(RECOVERY_INTERVAL_MS)
    h.api.onEvent({ type: 'hub-error', hubUrl: 'wss://b.example.com/computers', message: 'x' })
    await new Promise((r) => setTimeout(r, 20))
    expect(h.mints.length).toBe(3)
  })
})

describe('checkDialUrl', () => {
  test('a remote hub handing out a loopback address is refused', () => {
    expect(checkDialUrl(HUB_B, 'ws://127.0.0.1:7000/computers', null)).toMatch(/public address/)
    expect(checkDialUrl(HUB_B, 'wss://b.example.com/computers', null)).toBeNull()
  })
  test('a hub on this machine may use loopback, but never the local hub’s own address', () => {
    const local: RemoteHubEntry = { id: 'hub:lo', label: 'Lo', url: 'ws://127.0.0.1:7000/trpc' }
    expect(checkDialUrl(local, 'ws://127.0.0.1:7000/computers', null)).toBeNull()
    expect(
      checkDialUrl(local, 'ws://127.0.0.1:5000/computers', 'ws://127.0.0.1:5000/computers')
    ).toMatch(/local hub/)
  })
})
