import { constants, copyFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { openChatStorage } from '@slayzone/chat-runtime/server'
import { createChatRuntimeHandlers } from '../../computer/src/handlers/chat-runtime'

const fixture = process.env.CHAT_MIGRATION_AUDIT_FIXTURES

test.skipIf(!fixture)(
  'audit: measure real retained corpus metadata reads without live access',
  async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'chat-metadata-corpus-'))
    const storage = openChatStorage({ stateDir: dir, hubScope: 'audit' })
    const path = storage.path
    storage.close()
    copyFileSync(join(fixture!, 'computer.sqlite'), path, constants.COPYFILE_FICLONE)
    const pc = createChatRuntimeHandlers({
      stateDir: dir,
      hubScope: 'audit',
      computerId: () => 'audit',
      getProjectPaths: () => null,
      ctx: {
        config: {
          hubUrl: 'ws://audit/computers',
          name: 'audit',
          allowedRoots: [dir],
          capabilities: ['proc']
        },
        dialer: { notify: () => true },
        log: () => {}
      }
    })
    let copy: ReturnType<typeof openChatStorage> | undefined
    try {
      copy = openChatStorage({ stateDir: dir, hubScope: 'audit' })
      const raw = copy.compose((db) => db)
      const settings = raw
        .prepare("SELECT count(*) n,sum(length(value)) bytes FROM records WHERE kind='settings'")
        .get()
      const largest = raw
        .prepare(
          "SELECT c.id,sum(length(r.value)) bytes FROM conversations c JOIN records r ON r.conversation_id=c.id WHERE c.state='active' GROUP BY c.id ORDER BY bytes DESC LIMIT 1"
        )
        .get() as { id: string; bytes: number }
      const samples = []
      let pendingCount = 0
      for (let i = 0; i < 3; i++) {
        const at = performance.now()
        const pending = (await pc.request({ kind: 'pendingMetadata' })) as unknown[]
        samples.push(Math.round(performance.now() - at))
        pendingCount = pending.length
        expect(Array.isArray(pending)).toBe(true)
      }
      const at = performance.now()
      const snapshot = await pc.request({ kind: 'metadata.snapshot', id: largest.id })
      const report = {
        settings,
        pendingMetadataMs: samples,
        pendingCount,
        largestOwnerContentBytes: largest.bytes,
        largestSnapshotMs: Math.round(performance.now() - at),
        snapshotReplyBytes: JSON.stringify(snapshot).length
      }
      writeFileSync(join(fixture!, 'metadata-report.json'), JSON.stringify(report), { mode: 0o600 })
    } finally {
      copy?.close()
      await pc.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
  120_000
)
