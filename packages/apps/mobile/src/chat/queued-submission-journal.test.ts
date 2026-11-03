const mockFiles = new Map<string, string>()
let mockMoveFails = false
let mockMoveReplyLost = false
const mockMove = jest.fn()
jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  randomUUID: () => 'journal-staging-only',
  digestStringAsync: async (_algorithm: string, input: string) => encodeURIComponent(input)
}))
jest.mock('expo-file-system', () => {
  class File {
    uri: string
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts.map((part) => (typeof part === 'string' ? part : part.uri)).join('/')
    }
    get name() {
      return this.uri.split('/').at(-1)!
    }
    get exists() {
      return mockFiles.has(this.uri)
    }
    async text() {
      const value = mockFiles.get(this.uri)
      if (value === undefined) throw new Error('Missing file')
      return value
    }
    async write(value: string) {
      mockFiles.set(this.uri, value)
    }
    async move(destination: File, options?: { overwrite?: boolean }) {
      mockMove(options)
      if (mockMoveFails) throw new Error('Move failed')
      if (destination.exists) throw new Error('Destination exists')
      mockFiles.set(destination.uri, await this.text())
      mockFiles.delete(this.uri)
      this.uri = destination.uri // Expo mutates the source File after move.
      if (mockMoveReplyLost) throw new Error('Move result lost')
    }
    delete() {
      mockFiles.delete(this.uri)
    }
  }
  class Directory {
    uri: string
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts.map((part) => (typeof part === 'string' ? part : part.uri)).join('/')
    }
    create() {}
    list() {
      return [...mockFiles.keys()]
        .filter((uri) => uri.startsWith(this.uri + '/'))
        .map((uri) => new File(uri))
    }
  }
  return { File, Directory, Paths: { document: 'file:///review' } }
})

import { createQueuedSubmissionJournal } from './queued-submission-journal'
import type { QueuedSubmission } from '@slayzone/task-terminals/queued-submissions'
const entry: QueuedSubmission = {
  id: 'message',
  send: 'private text',
  original: 'private text',
  content: [{ type: 'text', text: 'private text' }],
  createdAt: 1,
  state: 'pending'
}
beforeEach(() => {
  mockFiles.clear()
  mockMoveFails = false
  mockMoveReplyLost = false
  mockMove.mockClear()
})

it('commits immutable entries without native overwrite and never deletes a moved destination', async () => {
  const journal = createQueuedSubmissionJournal('hub', 'tab')
  await journal.put(entry)
  const original = [...mockFiles.values()][0]
  await journal.put({ ...entry, state: 'failed', error: 'Lost ACK' })
  expect(mockMove).toHaveBeenCalledTimes(1)
  expect(mockMove).toHaveBeenCalledWith(undefined)
  expect([...mockFiles.values()]).toEqual([original])
  expect(await journal.list()).toEqual([entry])
  await expect(journal.put({ ...entry, send: 'conflicting' })).rejects.toThrow('identity conflict')
  expect([...mockFiles.values()]).toEqual([original])
})

it('failed commit preserves previously committed JSON and clears its partial staging', async () => {
  const journal = createQueuedSubmissionJournal('hub', 'tab')
  await journal.put(entry)
  mockMoveFails = true
  await expect(journal.put({ ...entry, id: 'other' })).rejects.toThrow('Move failed')
  expect(await journal.list()).toEqual([entry])
  expect([...mockFiles.keys()].some((key) => key.endsWith('.tmp'))).toBe(false)
})

it('a lost native move result retains the committed destination when the source URI changed', async () => {
  mockMoveReplyLost = true
  const journal = createQueuedSubmissionJournal('hub', 'tab')
  await journal.put(entry)
  expect(await journal.list()).toEqual([entry])
})

it('recovers valid abandoned staging, removes corrupt staging, isolates hubs, and removes all copies after ACK', async () => {
  const journal = createQueuedSubmissionJournal('hub', 'tab')
  await journal.put(entry)
  const path = [...mockFiles.keys()][0]
  const staged = { ...entry, id: 'staged' }
  mockFiles.set(path.replace('message.json', 'staged.abandoned.tmp'), JSON.stringify(staged))
  mockFiles.set(path.replace('message.json', 'broken.abandoned.tmp'), '{partial')
  expect((await journal.list()).map((value) => value.id)).toEqual(['message', 'staged'])
  expect(await createQueuedSubmissionJournal('other-hub', 'tab').list()).toEqual([])
  expect([...mockFiles.values()]).not.toContain('{partial')
  await journal.remove('staged')
  expect((await journal.list()).map((value) => value.id)).toEqual(['message'])
})
