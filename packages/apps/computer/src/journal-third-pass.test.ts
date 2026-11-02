import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, test, vi } from 'vitest'
import {
  startSessionHost,
  hostControl,
  connectorHost,
  type ConnectorGrant,
  runtimeDir,
  atomicRuntimeJson
} from './session-host'
import { createFakeClaude, echoTurn } from '../../../shared/test-utils/fake-claude'

async function fixture(legacyChatMarker?: string, stagedJournals = false) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'chat-journal-third-'))
  const fake = createFakeClaude({ root: join(root, 'fake') })
  fake.setScenario({ processes: [{ defaultTurn: echoTurn('answer: ') }] })
  const url = 'ws://journal-third.invalid/computers'
  const config = {
    hubUrl: url,
    name: 'audit',
    allowedRoots: [root],
    capabilities: ['proc'],
    binOverrideDir: fake.binDir
  }
  const journal = join(
    runtimeDir(root),
    'hooks-' + createHash('sha256').update(url).digest('hex').slice(0, 16) + '.json'
  )
  const disconnectedJournal = join(runtimeDir(root), 'hooks-' + 'a'.repeat(16) + '.json')
  mkdirSync(runtimeDir(root), { recursive: true })
  const hooks = [{ id: 'native-hook', params: { name: 'agent-hook', payload: { status: 'done' } } }]
  const legacy = legacyChatMarker
    ? [
        ...hooks,
        { id: 'old-chat', params: { name: 'chat-runtime', payload: { text: legacyChatMarker } } }
      ]
    : hooks
  writeFileSync(journal, JSON.stringify(legacy))
  writeFileSync(disconnectedJournal, JSON.stringify(legacy))
  const staged: string[] = []
  let activeStaging: string | undefined
  if (stagedJournals) {
    const dead = spawnSync(process.execPath, ['-e', '']).pid
    for (const [path, text] of [
      [`${journal}.${dead}.abcdef12.tmp`, JSON.stringify(legacy)],
      [`${disconnectedJournal}.${dead}.abcdef34.tmp`, JSON.stringify(legacy).slice(0, 45)]
    ]) {
      writeFileSync(path, text)
      staged.push(path)
    }
    activeStaging = `${journal}.${process.pid}.abcdef56.tmp`
    writeFileSync(activeStaging, JSON.stringify(legacy))
  }
  let host = await startSessionHost(root, config)
  let control = await hostControl(root)
  let allowDelivery = false
  let delivered = 0
  const transient: unknown[] = []
  async function connect() {
    const grant = await control.rpc.request<ConnectorGrant>('reserve', { hubUrl: url })
    const peer = await connectorHost(root, grant, url, {
      request: async (method) => {
        if (method !== 'event-deliver') throw new Error('Unexpected upstream call')
        if (!allowDelivery) throw new Error('Disconnected event delivery')
        delivered++
        return { ok: true }
      },
      notify: (method, params) => {
        if (method === 'event') transient.push(params)
      }
    })
    await peer.rpc.request('connected', { computerId: 'pc', mode: 'hello' })
    return peer
  }
  let peer = await connect()
  const request = (params: unknown) =>
    peer.rpc.request('dispatch', {
      method: 'chat.request',
      params,
      actor: { userId: null, route: null }
    })
  const route = { id: 'store', epoch: 1 }
  const storedEventCount = () => {
    const namespace = readdirSync(runtimeDir(root), { withFileTypes: true }).find(
      (d) => d.isDirectory() && /^[a-f0-9]{64}$/.test(d.name)
    )!
    const db = new Database(join(runtimeDir(root), namespace.name, 'chat.sqlite'), {
      readonly: true,
      fileMustExist: true
    })
    try {
      return (
        db.prepare("SELECT count(*) n FROM events WHERE conversation_id='store'").get() as {
          n: number
        }
      ).n
    } finally {
      db.close()
    }
  }
  const journalText = () => {
    try {
      return readFileSync(journal, 'utf8')
    } catch {
      return ''
    }
  }
  await request({
    kind: 'bootstrap',
    value: {
      identity: { id: 'store', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
      projectId: null,
      cwd: root,
      revision: 1,
      providerConfig: {},
      defaultFlags: null,
      env: {}
    }
  })
  const invoke = (method: string, args: unknown[], operationId: string) =>
    request({ kind: 'invoke', value: { route, target: 'ops', method, args, operationId } })
  return {
    root,
    staged,
    activeStaging,
    route,
    request,
    invoke,
    journalText,
    transient: () => transient,
    disconnectedJournalText: () => readFileSync(disconnectedJournal, 'utf8'),
    storedEventCount,
    connect,
    allow: () => {
      allowDelivery = true
    },
    delivered: () => delivered,
    restart: async () => {
      peer.close()
      control.close()
      await host.stop()
      host = await startSessionHost(root, config)
      control = await hostControl(root)
      peer = await connect()
    },
    close: async () => {
      peer.close()
      control.close()
      await host.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

test('task deletion and host restart erase buffered full chat notifications from hook journal', async () => {
  const marker = 'journal-private-normalized-message-marker'
  const f = await fixture(marker)
  try {
    // Upgrade scrubs old copies even for a hub no longer configured, without
    // dropping unrelated native hooks. New chat frames never enter the journal.
    expect(f.journalText()).not.toContain(marker)
    expect(f.disconnectedJournalText()).not.toContain(marker)
    expect(f.disconnectedJournalText()).toContain('native-hook')
    await f.invoke(
      'hydrate',
      [{ taskId: 'task', tabId: 'tab', mode: 'claude-chat', cwd: f.root }],
      'hydrate'
    )
    await f.invoke(
      'send',
      ['tab', { id: 'message', content: [{ type: 'text', text: marker }] }],
      'send'
    )
    await vi.waitFor(() => expect(f.storedEventCount()).toBeGreaterThan(0), { timeout: 15_000 })
    await vi.waitFor(() => expect(JSON.stringify(f.transient())).toContain(marker), {
      timeout: 15_000
    })
    expect(f.journalText()).not.toContain(marker)
    await f.request({ kind: 'task.lifecycle', taskId: 'task', state: 'deleted', revision: 1 })
    expect(await f.request({ kind: 'inspect', id: 'store' })).toMatchObject({ state: 'deleted' })
    expect(f.storedEventCount()).toBe(0)
    const beforeRestart = JSON.stringify(f.transient()).split(marker).length
    await f.restart()
    expect(await f.request({ kind: 'inspect', id: 'store' })).toMatchObject({ state: 'deleted' })
    expect(f.storedEventCount()).toBe(0)
    expect(f.journalText()).not.toContain(marker)
    expect(JSON.stringify(f.transient()).split(marker).length).toBe(beforeRestart)
  } finally {
    await f.close()
  }
}, 30_000)

test('control: acknowledgement drains buffered notifications from durable hook journal', async () => {
  const f = await fixture()
  try {
    await f.invoke(
      'hydrate',
      [{ taskId: 'task', tabId: 'tab', mode: 'claude-chat', cwd: f.root }],
      'hydrate'
    )
    await f.invoke(
      'send',
      [
        'tab',
        { id: 'message', content: [{ type: 'text', text: 'acknowledged-notification-marker' }] }
      ],
      'send'
    )
    expect(f.journalText()).toContain('native-hook')
    expect(f.journalText()).not.toContain('acknowledged-notification-marker')
    f.allow()
    await vi.waitFor(() => expect(f.journalText().trim()).toBe('[]'), { timeout: 5_000 })
    expect(f.delivered()).toBeGreaterThan(0)
  } finally {
    await f.close()
  }
}, 30_000)

test('upgrade removes abandoned complete and partial hook journal temps while retaining a live writer', async () => {
  const marker = 'legacy-private-temp-journal-marker'
  const f = await fixture(marker, true)
  try {
    for (const path of f.staged) expect(fs.existsSync(path)).toBe(false)
    expect(readFileSync(f.activeStaging!, 'utf8')).toContain(marker)
    expect(f.journalText()).toContain('native-hook')
    expect(f.journalText()).not.toContain(marker)
  } finally {
    await f.close()
  }
})

test.each(['partial-write', 'rename'] as const)(
  'atomic journal publication cleans failed %s temp bytes',
  (mode) => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'chat-journal-failure-'))
    const path = join(dir, 'hooks-' + 'b'.repeat(16) + '.json')
    const before = '[{"id":"authoritative-native-hook"}]'
    writeFileSync(path, before)
    try {
      const error = Object.assign(new Error('injected journal failure'), { code: 'ENOSPC' })
      if (mode === 'partial-write') {
        const write = fs.writeFileSync.bind(fs)
        vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((file, data, options) => {
          write(file, String(data).slice(0, 48), options)
          throw error
        })
      } else
        vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
          throw error
        })
      syncBuiltinESMExports()
      expect(() =>
        atomicRuntimeJson(path, [{ private: 'unpublished-private-chat-marker' }])
      ).toThrow(error)
      expect(readdirSync(dir)).toEqual([basename(path)])
      expect(readFileSync(path, 'utf8')).toBe(before)
    } finally {
      vi.restoreAllMocks()
      syncBuiltinESMExports()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
