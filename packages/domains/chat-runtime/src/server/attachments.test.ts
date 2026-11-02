import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, test } from 'vitest'
import { createComputerChatRuntime } from './computer-runtime'
const roots: string[] = [],
  runtimes: Array<ReturnType<typeof createComputerChatRuntime>> = []
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.close()
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true })
})
function runtime() {
  const stateDir = mkdtempSync(join(tmpdir(), 'slz-chat-files-'))
  roots.push(stateDir)
  const r = createComputerChatRuntime({ stateDir, hubScope: 'hub-a', computerId: 'pc' })
  runtimes.push(r)
  r.bootstrap({
    identity: { id: 'storage', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
    projectId: null,
    cwd: '/tmp',
    revision: 1,
    providerConfig: {},
    defaultFlags: null,
    env: {}
  })
  return r
}
const bytes = Buffer.from('private attachment')
const attachment = {
  artifactId: 'artifact',
  name: 'notes.txt',
  kind: 'text' as const,
  mediaType: 'text/plain' as const,
  size: bytes.length
}
test('seals local attachment bytes and preserves their hash when referenced later', async () => {
  const r = runtime()
  const ref = r.attachments.put('tab', attachment, bytes)
  expect(ref.contentHash).toBe(createHash('sha256').update(bytes).digest('hex'))
  expect(Buffer.from(await r.attachments.reader.read(ref))).toEqual(bytes)
  expect(await r.local.data.attachments.hasVersion('artifact', ref.contentHash!)).toBe(true)
})
test('caller cannot register a false hash or read another artifact by bare hash', async () => {
  const r = runtime()
  expect(() =>
    r.attachments.put('tab', { ...attachment, contentHash: '0'.repeat(64) }, bytes)
  ).toThrow(/hash/i)
  const ref = r.attachments.put('tab', attachment, bytes)
  await expect(r.attachments.reader.read({ ...ref, artifactId: 'foreign' })).rejects.toThrow(
    /artifact/i
  )
  await expect(
    r.attachments.reader.read({ ...ref, contentHash: '../chat.sqlite' })
  ).rejects.toThrow()
})
