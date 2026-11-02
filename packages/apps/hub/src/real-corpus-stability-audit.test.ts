import Database from 'better-sqlite3'
import {
  constants,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { expect, test } from 'vitest'
import { bootstrapSchema } from './bootstrap-schema'
import { createSlayzoneDbAdapter } from '../../../shared/test-utils/ipc-harness'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import { taskSessionStore } from '@slayzone/task/server'
import { createChatRuntimeHandlers } from '../../computer/src/handlers/chat-runtime'
import { createComputerChatServices } from './computer-chat'
import { openChatStorage } from '@slayzone/chat-runtime/server'

// Opt-in private fixture: before.sqlite (schema186 upgrade backup) and a read-only
// directory of original content-addressed blobs. No providers or live services.
const fixture = process.env.CHAT_MIGRATION_AUDIT_FIXTURES
const blobs = process.env.CHAT_MIGRATION_AUDIT_BLOBS

test.skipIf(!fixture || !blobs)(
  'audit: replay full pre-upgrade corpus, compare every event, reconnect',
  async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'chat-full-corpus-'))
    const hubPath = join(dir, 'hub.sqlite')
    copyFileSync(join(fixture!, 'before.sqlite'), hubPath, constants.COPYFILE_FICLONE)
    const db = new Database(hubPath)
    db.pragma('journal_mode=WAL')
    db.pragma('foreign_keys=ON')
    bootstrapSchema(db)
    // Normalize execution placement only; historical content and tab modes stay untouched.
    db.prepare('UPDATE tasks SET worktree_path=?').run(dir)
    const computerId =
      (
        db
          .prepare(
            'SELECT computer_id FROM chat_workspace_changes WHERE computer_id IS NOT NULL LIMIT 1'
          )
          .get() as { computer_id: string } | undefined
      )?.computer_id ?? 'audit-computer'
    const slayDb = createSlayzoneDbAdapter(db)
    const pc = createChatRuntimeHandlers({
      stateDir: dir,
      hubScope: 'audit',
      computerId: () => computerId,
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
    const errors: Record<string, number> = {}
    let requests = 0
    const openHub = () =>
      createComputerChatServices({
        db: slayDb,
        legacyData: {
          ...createDbChatDataOps(slayDb, taskSessionStore),
          buildMcpEnv: async () => ({}),
          getProjectRoot: async () => dir
        },
        attachments: {
          read: async (ref) => {
            if (!/^[a-f0-9]{64}$/.test(ref.contentHash ?? ''))
              throw new Error('Audit requires a sealed source blob')
            return readFileSync(
              join(blobs!, ref.contentHash!.slice(0, 2), ref.contentHash!.slice(2))
            )
          }
        },
        request: async (_id, req) => {
          requests++
          try {
            return await pc.request(JSON.parse(JSON.stringify(req)))
          } catch (error) {
            const kind = (req as { kind: string }).kind
            const reason =
              error instanceof Error && error.name === 'ZodError'
                ? 'schema-validation'
                : (error as Error).message
            const key = `${kind}: ${reason}`
            errors[key] = (errors[key] ?? 0) + 1
            throw error
          }
        },
        resolveComputer: async () => computerId,
        defaultComputer: async () => computerId,
        hasLiveTask: async () => false
      })
    const started = Date.now()
    let target: ReturnType<typeof openChatStorage> | undefined
    let before: Database.Database | undefined
    try {
      const services = openHub()
      await services.migrateIdleComputer(computerId)
      const owners = db
        .prepare('SELECT state,count(*) AS n FROM chat_ownership GROUP BY state')
        .all()
      const migrationMs = Date.now() - started
      const tabsBeforeReconnect = (
        db
          .prepare("SELECT count(*) n FROM terminal_tabs WHERE id LIKE 'prompt-history:%'")
          .get() as { n: number }
      ).n
      const reconnectStart = Date.now()
      let reconnectError: string | null = null
      try {
        await openHub().recoverComputer(computerId, true)
      } catch (error) {
        reconnectError = (error as Error).message
      }
      const reconnectMs = Date.now() - reconnectStart
      const tabsAfterReconnect = (
        db
          .prepare("SELECT count(*) n FROM terminal_tabs WHERE id LIKE 'prompt-history:%'")
          .get() as { n: number }
      ).n
      await pc.close()
      target = openChatStorage({ stateDir: dir, hubScope: 'audit' })
      before = new Database(join(fixture!, 'before.sqlite'), { readonly: true })
      const computer = target.compose((raw) => raw)
      const ownerByTab = new Map(
        (
          computer
            .prepare("SELECT id,tab_id FROM conversations WHERE state='active'")
            .all() as Array<{ id: string; tab_id: string }>
        ).map((o) => [o.tab_id, o.id])
      )
      let events = 0,
        sourceOnly = 0,
        missingOrDifferent = 0
      for (const row of before
        .prepare('SELECT tab_id,seq,event FROM chat_events')
        .iterate() as Iterable<{ tab_id: string; seq: number; event: string }>) {
        const id = ownerByTab.get(row.tab_id)
        const migrated = id
          ? (computer
              .prepare('SELECT event FROM events WHERE conversation_id=? AND seq=?')
              .get(id, row.seq) as { event: string } | undefined)
          : undefined
        if (migrated && isDeepStrictEqual(JSON.parse(migrated.event), JSON.parse(row.event)))
          events++
        else {
          const source = db
            .prepare('SELECT event FROM chat_events WHERE tab_id=? AND seq=?')
            .get(row.tab_id, row.seq) as { event: string } | undefined
          if (source && isDeepStrictEqual(JSON.parse(source.event), JSON.parse(row.event)))
            sourceOnly++
          else missingOrDifferent++
        }
      }
      const nativeEvents = (
        before
          .prepare(
            "SELECT count(*) n FROM chat_events e JOIN terminal_tabs t ON t.id=e.tab_id WHERE t.mode NOT IN ('claude-chat','codex-chat')"
          )
          .get() as { n: number }
      ).n
      const report = {
        nativeEvents,
        migrationMs,
        reconnectMs,
        requests,
        owners,
        events,
        sourceOnly,
        missingOrDifferent,
        errors,
        reconnectError,
        tabsBeforeReconnect,
        tabsAfterReconnect
      }
      writeFileSync(join(fixture!, 'replay-report.json'), JSON.stringify(report), { mode: 0o600 })
      expect(missingOrDifferent).toBe(0)
      expect(sourceOnly).toBe(nativeEvents)
      expect(errors).toEqual({})
      expect(reconnectError).toBeNull()
      expect(tabsAfterReconnect).toBe(tabsBeforeReconnect)
    } finally {
      before?.close()
      target?.close()
      await pc.close()
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
  600_000
)
