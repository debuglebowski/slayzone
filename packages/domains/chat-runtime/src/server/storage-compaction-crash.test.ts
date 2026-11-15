/**
 * Storage compaction is kill -9 safe (fu-2): a child process runs a real rebuild and
 * SIGKILLs itself at each step; the next open finds a usable store with every
 * committed row, no leftover files, and the old or the new file — never a mix.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { openChatStorage, type ChatStorage } from './storage'

const text = (t: string) => ({ kind: 'assistant-text', messageId: t, text: t }) as const
const roots: string[] = []
const stores: ChatStorage[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const POINTS = [
  'worker-started',
  'copy-synced',
  'copied',
  'round',
  'window',
  'verified',
  'closed',
  'linked',
  'renamed'
] as const
/** Points at which the swap has replaced the file. */
const SWAPPED = new Set(['renamed'])
/** Points after the five `w` writes made at `copied`. */
const WRITTEN = new Set(['copied', 'round', 'window', 'verified', 'closed', 'linked', 'renamed'])

test.each(POINTS)('SIGKILL at %s leaves a usable store', (point) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'slz-compact-kill-'))
  roots.push(root)
  const url = (file: string) => pathToFileURL(join(import.meta.dirname, file)).href
  const child = join(root, 'kill-child.mjs')
  writeFileSync(
    child,
    `
import { openChatStorage } from ${JSON.stringify(url('storage.ts'))}
import { createStorageCompaction } from ${JSON.stringify(url('storage-compaction.ts'))}
const point = ${JSON.stringify(point)}
const id = { id: 'c', taskId: 't', tabId: 'tab', mode: 'claude-chat', epoch: 1 }
const text = (t) => ({ kind: 'assistant-text', messageId: t, text: t })
const store = openChatStorage({ stateDir: ${JSON.stringify(root)}, hubScope: 'hub' })
store.createConversation(id)
const big = 'b'.repeat(100_000)
store.transaction(() => {
  for (let i = 0; i < 100; i++) store.append('c', 1, text('gone ' + i + ' ' + big))
  for (let i = 0; i < 20; i++) store.append('c', 1, text('kept ' + i))
})
store.compose((db) => db.prepare("DELETE FROM events WHERE event LIKE '%gone %'").run())
store.checkpoint()
const c = createStorageCompaction({
  storage: store,
  backfillDone: () => true,
  automaticReclaim: false,
  log: () => undefined,
  finalKeys: point === 'round' ? 0 : 256,
  onPhase: (phase) => {
    if (phase === 'copied') for (let i = 0; i < 5; i++) store.append('c', 1, text('w' + i))
    if (phase === point) process.kill(process.pid, 'SIGKILL')
  }
})
c.start()
await c.idle()
console.error('kill point not reached: ' + JSON.stringify(c.status().job))
process.exit(3)
`,
    { mode: 0o600 }
  )
  const run = spawnSync(process.execPath, ['--import', 'tsx', child], {
    cwd: join(import.meta.dirname, '../../../../..'),
    env: { ...process.env, HOME: root, USERPROFILE: root },
    encoding: 'utf8',
    timeout: 60_000
  })
  expect(run.stderr, `child stderr: ${run.stderr}`).toBe('')
  expect(run.signal).toBe('SIGKILL')

  const store = openChatStorage({ stateDir: root, hubScope: 'hub' })
  stores.push(store)
  const texts = store.read('c', -1).map((e) => (e.event as { text: string }).text)
  expect(texts.filter((t) => t.startsWith('kept '))).toHaveLength(20)
  expect(texts.filter((t) => /^w\d$/.test(t))).toHaveLength(WRITTEN.has(point) ? 5 : 0)
  expect(texts.some((t) => t.startsWith('gone '))).toBe(false)
  expect(store.compose((db) => db.pragma('quick_check', { simple: true }))).toBe('ok')
  expect(store.maintenance.fileStats().autoVacuum).toBe(SWAPPED.has(point) ? 2 : 0)
  expect(readdirSync(store.dir).filter((n) => n.startsWith('chat.sqlite.'))).toEqual([])
  // still writable
  store.append('c', 1, text('after'))
  expect(store.read('c', -1).at(-1)?.event).toMatchObject({ text: 'after' })
})
