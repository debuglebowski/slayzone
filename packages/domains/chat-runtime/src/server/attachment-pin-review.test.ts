import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { openChatStorage } from './storage'

test.each(['tool-call', 'tool-result'] as const)(
  'attachment pinning preserves arbitrary %s metadata that resembles an attachment',
  (kind) => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-tool-metadata-pin-'))
    const store = openChatStorage({ stateDir: dir, hubScope: 'audit' })
    try {
      store.createConversation({
        id: 'chat',
        taskId: 'task',
        tabId: 'tab',
        mode: 'claude-chat',
        epoch: 1
      })
      const metadata = {
        artifactId: 'external-tool-object',
        name: 'metadata.txt',
        kind: 'text',
        mediaType: 'text/plain',
        size: 3
      }
      const event =
        kind === 'tool-call'
          ? { kind, id: 'call', name: 'external-service', input: metadata }
          : { kind, toolUseId: 'call', isError: false, rawContent: metadata, structured: metadata }
      expect(() => store.append('chat', 1, event)).not.toThrow()
      expect(store.read('chat', -1)[0].event).toEqual(event)
      expect(store.records('chat').filter((r) => r.kind === 'attachment')).toEqual([])
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
