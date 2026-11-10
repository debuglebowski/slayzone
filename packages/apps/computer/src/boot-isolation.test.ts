/**
 * P3 — one bad file never stops the computer from starting. A torn hook journal
 * keeps its readable events (the rest is quarantined, decision 7), a corrupt
 * generations file is set aside, and an event the hub rejects as invalid is
 * quarantined instead of blocking every later hook.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listQuarantine } from '@slayzone/platform/quarantine'
import { afterEach, expect, test, vi } from 'vitest'
import {
  connectorHost,
  type ConnectorGrant,
  hostControl,
  runtimeDir,
  startSessionHost
} from './session-host'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const url = 'ws://boot-isolation.invalid/computers'
const journalOf = (root: string, hub: string) =>
  join(
    runtimeDir(root),
    'hooks-' + createHash('sha256').update(hub).digest('hex').slice(0, 16) + '.json'
  )

function setup() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'computer-boot-isolation-'))
  roots.push(root)
  mkdirSync(runtimeDir(root), { recursive: true })
  const config = { hubUrl: url, name: 'boot', allowedRoots: [root], capabilities: ['proc'] }
  return { root, config }
}

const hook = (id: string, taskId = 'task') => ({
  id,
  params: { name: 'agent-hook', payload: { taskId, status: 'done' } }
})

test('a torn hook journal (configured or disconnected hub) keeps its readable events and boots', async () => {
  const { root, config } = setup()
  const torn = JSON.stringify([hook('a'), hook('b')]).slice(0, -20)
  writeFileSync(journalOf(root, url), torn)
  writeFileSync(join(runtimeDir(root), `hooks-${'a'.repeat(16)}.json`), '{"not":"an array"}')
  const host = await startSessionHost(root, config)
  try {
    expect(JSON.parse(readFileSync(journalOf(root, url), 'utf8'))).toEqual([hook('a')])
    expect(
      listQuarantine(runtimeDir(root))
        .map((e) => e.pass)
        .sort()
    ).toEqual(['hook-journal', 'hook-journal'])
  } finally {
    await host.stop()
  }
})

test('a corrupt generations file is set aside; the host starts fresh', async () => {
  const { root, config } = setup()
  writeFileSync(join(runtimeDir(root), 'generations.json'), '{"ws://x": "not a number"')
  const host = await startSessionHost(root, config)
  try {
    expect(listQuarantine(runtimeDir(root))).toMatchObject([{ pass: 'computer-generations' }])
    const control = await hostControl(root)
    try {
      const grant = await control.rpc.request<ConnectorGrant>('reserve', { hubUrl: url })
      expect(grant.generation).toBe(1)
    } finally {
      control.close()
    }
  } finally {
    await host.stop()
  }
})

test('an event the hub rejects as invalid is quarantined; later events still deliver', async () => {
  const { root, config } = setup()
  writeFileSync(journalOf(root, url), JSON.stringify([hook('bad', 'task-x'), hook('good')]))
  const host = await startSessionHost(root, config)
  const control = await hostControl(root)
  const delivered: string[] = []
  try {
    const grant = await control.rpc.request<ConnectorGrant>('reserve', { hubUrl: url })
    const peer = await connectorHost(root, grant, url, {
      request: async (method, raw) => {
        if (method !== 'event-deliver') throw new Error('Unexpected upstream call')
        const event = raw as { id: string }
        if (event.id === 'bad') return { ok: false, rejected: 'invalid event delivery' }
        delivered.push(event.id)
        return { ok: true }
      },
      notify: () => {}
    })
    await peer.rpc.request('connected', { computerId: 'pc', mode: 'hello' })
    await vi.waitFor(() => expect(delivered).toEqual(['good']), { timeout: 5000 })
    expect(JSON.parse(readFileSync(journalOf(root, url), 'utf8'))).toEqual([])
    expect(listQuarantine(runtimeDir(root))).toMatchObject([
      { pass: 'hook-event-rejected', meta: { taskId: 'task-x' } }
    ])
    peer.close()
  } finally {
    control.close()
    await host.stop()
  }
})
