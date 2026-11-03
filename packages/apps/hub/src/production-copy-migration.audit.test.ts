import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { expect, test } from 'vitest'
import { openChatStorage } from '@slayzone/chat-runtime/server'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import { taskSessionStore } from '@slayzone/task/server'
import { createSlayzoneDbAdapter } from '../../../shared/test-utils/ipc-harness'
import { createChatRuntimeHandlers } from '../../computer/src/handlers/chat-runtime'
import { bootstrapSchema } from './bootstrap-schema'
import { createChatAttachmentReader } from './chat-attachment-reader'
import { createComputerChatServices } from './computer-chat'
import { createDiagnosticTaskResolver, createLegacyChatDiagnostics } from './chat-diagnostics'

// Explicit, local opt-in. Inputs must already be private, coherent copies. This
// suite never discovers an installation or opens a source production database.
const auditRoot = process.env.CHAT_PRODUCTION_AUDIT_ROOT
const injectDisconnects = process.env.CHAT_PRODUCTION_AUDIT_FAULTS === '1'
const allowedRequests = new Set([
  'inventory',
  'inspect',
  'inspectTab',
  'catalog',
  'metadata.snapshot',
  'pendingMetadata',
  'ackMetadata',
  'diagnostics.configure',
  'retention.configure',
  'task.lifecycle',
  'conversation.delete',
  'conversation.transition',
  'folders.inventory',
  'folders.delete',
  'migration.checkpoint',
  'migration.prepared',
  'migration.verify',
  'migration.activate',
  'transfer.begin',
  'transfer.chunk',
  'transfer.finish',
  'attachment.has',
  'attachment.put',
  'attachment.read',
  'bootstrap',
  'prompts',
  'prompt.summaries',
  'sessions'
])
type Raw = Database.Database
type EventRow = {
  tab_id: string
  conversation_id: string
  seq: number
  event: string
  saved_at: number
}
type RecordRow = { conversation_id: string; kind: string; id: string; value: string }
type DraftRow = {
  tab_id: string
  draft_text: string
  draft_attachments: string | null
  scroll_anchor: string | null
  rev: number
}
type QueueRow = {
  id: string
  tab_id: string
  send: string
  original: string
  position: number
  created_at: string
  content: string | null
  conversation_id: string | null
}
type PromptRow = {
  id: string
  task_id: string
  agent_id: string
  cli_session_id: string | null
  text: string
  created_at: number
}
type CheckpointRow = { tab_id: string; version: string; seq: number; data: string }
type PageRow = {
  tab_id: string
  page: number
  start_row: number
  end_row: number
  rows: string
  summary: string
  search_text: string
}
type AttachmentMessageRow = { task_id: string; message_id: string; attachments: string }
type WorkspaceRow = {
  id: string
  tab_id: string
  message_id: string
  computer_id: string | null
  root_path: string
  status: string
  reason: string | null
  files: string
  created_at: number
}
type TurnRow = {
  id: string
  task_id: string | null
  terminal_tab_id: string
  worktree_path: string
  snapshot_sha: string
  head_sha_at_snap: string | null
  prompt_preview: string
  created_at: number
}
type DiagnosticRow = {
  id: string
  ledger_task_id: string | null
  payload_json: string | null
  [key: string]: unknown
}
type AuditRequest = {
  id: string
  manifest: { header: { identity: { id: string; tabId: string }; events: number } }
}

function privateRoot() {
  const root = realpathSync(auditRoot!)
  const marker = JSON.parse(readFileSync(join(root, 'production-copy-audit.json'), 'utf8'))
  if (marker.isolation !== 'offline-copy-only' || root.includes(`${sep}.slayzone${sep}`))
    throw new Error('Expected an isolated production-copy audit directory')
  if ((lstatSync(root).mode & 0o077) !== 0) throw new Error('Audit directory must be private')
  return root
}
function clone(from: string, to: string) {
  const stat = lstatSync(from)
  if (stat.isSymbolicLink()) throw new Error('Audit refuses symlinks')
  if (stat.isDirectory()) {
    mkdirSync(to, { recursive: true, mode: 0o700 })
    for (const entry of readdirSync(from)) clone(join(from, entry), join(to, entry))
  } else if (stat.isFile()) {
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
    copyFileSync(from, to, constants.COPYFILE_FICLONE)
    chmodSync(to, 0o600)
    const target = lstatSync(to)
    if (stat.ino === target.ino && stat.dev === target.dev)
      throw new Error('Audit refuses hard links')
  } else throw new Error('Audit refuses special files')
}
const count = (db: Raw, sql: string) => (db.prepare(sql).get() as { n: number }).n
const rows = <T>(db: Raw, sql: string) => db.prepare(sql).iterate() as Iterable<T>
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const jsonEqual = (a: string, b: string) => isDeepStrictEqual(JSON.parse(a), JSON.parse(b))

for (const label of ['stable-legacy', 'dev-legacy', 'dev-current']) {
  test.skipIf(!auditRoot)(
    `private copy: ${label} migration, restart, exact content verification`,
    async () => {
      const root = privateRoot()
      const dir = join(root, 'work', `${label}-${Date.now()}`)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const reportPath = join(root, 'reports', `${label}${injectDisconnects ? '-faults' : ''}.json`)
      const report: Record<string, unknown> & {
        forbiddenOperations: number
        foreignKeysBefore?: number
      } = { case: label, workDir: dir, stage: 'setup', forbiddenOperations: 0 }
      const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 })
      const deny = () => {
        report.forbiddenOperations++
        throw new Error('Offline audit forbids provider or process invocation')
      }
      clone(join(root, 'inputs', label, 'before.sqlite'), join(dir, 'hub.sqlite'))
      clone(
        join(root, 'inputs', label === 'stable-legacy' ? 'stable-legacy/files' : 'dev-files'),
        join(dir, 'hub-files')
      )
      const db = new Database(join(dir, 'hub.sqlite'))
      db.pragma('journal_mode=WAL')
      db.pragma('foreign_keys=ON')
      report.hubSchemaBefore = db.pragma('user_version', { simple: true })
      report.foreignKeysBefore = (db.pragma('foreign_key_check') as unknown[]).length
      const pcs = new Map<string, ReturnType<typeof createChatRuntimeHandlers>>()
      const pcDirs = new Map<string, string>()
      let diagnosticsDb: Raw | undefined
      let diagnosticsBaseline: Raw | undefined
      let baseline: Raw | undefined
      const inspected: ReturnType<typeof openChatStorage>[] = []
      try {
        const bootAt = performance.now()
        bootstrapSchema(db)
        report.schemaMigrationMs = Math.round(performance.now() - bootAt)
        report.hubSchemaAfter = db.pragma('user_version', { simple: true })
        // Paths for hypothetical execution are disposable; content and historical
        // computer/session provenance are never rewritten.
        db.prepare('UPDATE tasks SET worktree_path=?').run(dir)
        await db.backup(join(dir, 'baseline.sqlite'))
        chmodSync(join(dir, 'baseline.sqlite'), 0o600)
        baseline = new Database(join(dir, 'baseline.sqlite'), { readonly: true })
        const rawIds = (
          db
            .prepare(`
        SELECT computer_id AS id FROM chat_workspace_changes WHERE computer_id IS NOT NULL
        UNION SELECT computer_id FROM chat_ownership WHERE computer_id IS NOT NULL
        UNION SELECT destination_computer_id FROM chat_ownership WHERE destination_computer_id IS NOT NULL
        UNION SELECT id FROM computers WHERE revoked_at IS NULL
      `)
            .all() as Array<{ id: string }>
        ).map((r) => r.id)
        const fallback =
          (
            db
              .prepare(
                'SELECT computer_id AS id FROM chat_workspace_changes WHERE computer_id IS NOT NULL LIMIT 1'
              )
              .get() as { id: string } | undefined
          )?.id ??
          rawIds[0] ??
          'offline-audit-computer'
        const ids = [...new Set([fallback, ...rawIds])]
        report.simulatedComputers = ids.length
        const slayDb = createSlayzoneDbAdapter(db)
        let existingComputer: string | undefined
        if (label === 'dev-current') {
          const ownerIds = db
            .prepare(
              "SELECT DISTINCT computer_id AS id FROM chat_ownership WHERE state='active' AND computer_id IS NOT NULL"
            )
            .all() as Array<{ id: string }>
          if (ownerIds.length !== 1)
            throw new Error('Current snapshot requires one copied storage per owning computer')
          existingComputer = ownerIds[0].id
        }
        function computer(id: string) {
          const prior = pcs.get(id)
          if (prior) return prior
          let stateDir = pcDirs.get(id)
          if (!stateDir) {
            stateDir = join(dir, `computer-${pcDirs.size + 1}`)
            pcDirs.set(id, stateDir)
            if (id === existingComputer) {
              const empty = openChatStorage({ stateDir, hubScope: 'offline-audit' })
              const target = empty.path
              empty.close()
              clone(join(root, 'inputs/dev-computer/computer.sqlite'), target)
              clone(join(root, 'inputs/dev-computer/files'), dirname(target))
            }
          }
          const pc = createChatRuntimeHandlers({
            stateDir,
            hubScope: 'offline-audit',
            computerId: () => id,
            getProjectPaths: () => null,
            admission: {
              enqueue: deny,
              cancel: () => false,
              prioritize: () => false,
              isQueued: () => false,
              stats: () => ({ queued: 0, active: 0, concurrency: 0 })
            },
            ctx: {
              config: {
                hubUrl: 'ws://offline.invalid/computers',
                name: 'offline-audit',
                allowedRoots: [dir],
                capabilities: []
              },
              dialer: { notify: () => true },
              log: () => {}
            }
          })
          pcs.set(id, pc)
          return pc
        }
        // Stable diagnostics are contemporaneous with its legacy hub. A historical
        // dev hub backup has no matching diagnostics backup, so it is not paired
        // with today's unrelated diagnostic contents.
        let diagnostics: ReturnType<typeof createLegacyChatDiagnostics> | undefined
        if (label !== 'dev-legacy') {
          clone(
            join(
              root,
              'inputs',
              label === 'stable-legacy' ? 'stable-diagnostics.sqlite' : 'dev-diagnostics.sqlite'
            ),
            join(dir, 'diagnostics.sqlite')
          )
          diagnosticsDb = new Database(join(dir, 'diagnostics.sqlite'))
          diagnostics = createLegacyChatDiagnostics({
            db: createSlayzoneDbAdapter(diagnosticsDb),
            resolveTask: createDiagnosticTaskResolver(slayDb)
          })
          await diagnostics.initialize()
          report.unassignedDiagnosticsBefore = await diagnostics.unassigned()
          await diagnosticsDb.backup(join(dir, 'diagnostics-baseline.sqlite'))
          chmodSync(join(dir, 'diagnostics-baseline.sqlite'), 0o600)
          diagnosticsBaseline = new Database(join(dir, 'diagnostics-baseline.sqlite'), {
            readonly: true
          })
        }
        const errors: Record<string, number> = {}
        report.errors = errors
        const faultKinds = new Set(['transfer.chunk', 'transfer.finish', 'migration.activate'])
        const faultOwners = new Set<string>()
        const transferOwners = new Map<string, { id: string; tabId: string; events: number }>()
        const injected: Array<{
          afterRequest: string
          sourceEvents: number
          sourceRetained: boolean
        }> = []
        report.injectedDisconnects = injected
        let requests = 0
        const attachmentReader = createChatAttachmentReader(slayDb, join(dir, 'hub-files'))
        const service = () =>
          createComputerChatServices({
            db: slayDb,
            diagnostics,
            legacyData: {
              ...createDbChatDataOps(slayDb, taskSessionStore),
              buildMcpEnv: async () => ({}),
              getProjectRoot: async () => dir
            },
            attachments: attachmentReader,
            request: async (id, request) => {
              const kind = (request as { kind: string }).kind
              if (!allowedRequests.has(kind)) return deny()
              requests++
              if (requests % 250 === 0) {
                report.requests = requests
                save()
              }
              try {
                const reply = await computer(id).request(JSON.parse(JSON.stringify(request)))
                const raw = request as AuditRequest
                if (kind === 'transfer.begin') {
                  const manifest = raw.manifest
                  transferOwners.set((reply as { id: string }).id, {
                    ...manifest.header.identity,
                    events: manifest.header.events
                  })
                }
                const owner =
                  kind === 'migration.activate'
                    ? (db
                        .prepare('SELECT id,tab_id AS tabId FROM chat_ownership WHERE id=?')
                        .get(raw.id) as { id: string; tabId: string; events?: number } | undefined)
                    : transferOwners.get(raw.id)
                if (
                  injectDisconnects &&
                  faultKinds.has(kind) &&
                  owner &&
                  !faultOwners.has(owner.id)
                ) {
                  const sourceEvents = (
                    db
                      .prepare('SELECT count(*) n FROM chat_events WHERE tab_id=?')
                      .get(owner.tabId) as { n: number }
                  ).n
                  if (sourceEvents > 0) {
                    const expectedEvents = (
                      baseline!
                        .prepare('SELECT count(*) n FROM chat_events WHERE tab_id=?')
                        .get(owner.tabId) as { n: number }
                    ).n
                    if (sourceEvents !== expectedEvents)
                      throw new Error('Source was cleaned before activation acknowledgement')
                    faultKinds.delete(kind)
                    faultOwners.add(owner.id)
                    injected.push({ afterRequest: kind, sourceEvents, sourceRetained: true })
                    save()
                    throw new Error('AUDIT_SIMULATED_ACK_LOSS')
                  }
                }
                return reply
              } catch (error) {
                if (error instanceof Error && error.message === 'AUDIT_SIMULATED_ACK_LOSS')
                  throw error
                const reason =
                  error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error'
                const key = `${kind}: ${reason}`
                errors[key] = (errors[key] ?? 0) + 1
                throw error
              }
            },
            resolveComputer: async (taskId) => {
              const owned = db
                .prepare(
                  "SELECT computer_id AS id FROM chat_ownership WHERE task_id=? AND state='active' AND computer_id IS NOT NULL ORDER BY rowid LIMIT 1"
                )
                .get(taskId) as { id: string } | undefined
              const placed = db
                .prepare(
                  "SELECT p.computer_id AS id FROM project_placements p JOIN tasks t ON t.project_id=p.project_id WHERE t.id=? AND p.status='ready' ORDER BY p.updated_at DESC LIMIT 1"
                )
                .get(taskId) as { id: string } | undefined
              return owned?.id ?? placed?.id ?? fallback
            },
            defaultComputer: async () => fallback,
            connected: () => true,
            chatRuntimeReady: () => true,
            hasLiveTask: async () => false,
            beforeInvoke: async () => deny(),
            retentionDays: 0
          })
        report.stage = 'migration'
        save()
        const started = performance.now()
        let services = service()
        for (const id of ids) await services.migrateIdleComputer(id)
        report.migrationMs = Math.round(performance.now() - started)
        report.stage = 'restart'
        save()
        for (const pc of pcs.values()) await pc.close()
        pcs.clear()
        services = service()
        const restartAt = performance.now()
        for (const id of ids) await services.recoverComputer(id, true)
        for (const id of ids) await services.migrateIdleComputer(id)
        for (const id of ids) await services.recoverComputer(id, true)
        report.restartAndRepeatMs = Math.round(performance.now() - restartAt)
        for (const pc of pcs.values()) await pc.close()
        pcs.clear()
        report.stage = 'verify'
        save()
        const stores: Raw[] = []
        for (const stateDir of pcDirs.values()) {
          const storage = openChatStorage({ stateDir, hubScope: 'offline-audit' })
          inspected.push(storage)
          stores.push(storage.compose((raw) => raw))
        }
        function record(tabId: string, kind: string, id: string) {
          for (const store of stores) {
            const found = store
              .prepare(
                "SELECT r.value FROM records r JOIN conversations c ON c.id=r.conversation_id WHERE c.tab_id=? AND r.kind=? AND r.id=? AND c.state='active'"
              )
              .get(tabId, kind, id) as { value: string } | undefined
            if (found) return JSON.parse(found.value)
          }
        }
        function taskRecord(taskId: string | null, kind: string, id: string) {
          const found: unknown[] = []
          if (!taskId) return found
          for (const store of stores)
            for (const r of store
              .prepare(
                "SELECT r.value FROM records r JOIN conversations c ON c.id=r.conversation_id WHERE c.task_id=? AND r.kind=? AND r.id=? AND c.state='active'"
              )
              .all(taskId, kind, id) as Array<{ value: string }>)
              found.push(JSON.parse(r.value))
          return found
        }
        const verified: Record<
          string,
          { checked: number; migrated: number; retained: number; missingOrChanged: number }
        > = {}
        function check(kind: string, migrated: boolean, retained: boolean) {
          const result = (verified[kind] ??= {
            checked: 0,
            migrated: 0,
            retained: 0,
            missingOrChanged: 0
          })
          result.checked++
          if (migrated) result.migrated++
          else if (retained) result.retained++
          else result.missingOrChanged++
        }
        if (label === 'dev-current') {
          const original = new Database(join(root, 'inputs/dev-computer/computer.sqlite'), {
            readonly: true
          })
          try {
            for (const r of rows<EventRow>(original, 'SELECT * FROM events')) {
              const found = stores
                .map(
                  (s) =>
                    s
                      .prepare(
                        'SELECT event,saved_at FROM events WHERE conversation_id=? AND seq=?'
                      )
                      .get(r.conversation_id, r.seq) as
                      | { event: string; value: string; saved_at: number }
                      | undefined
                )
                .find(Boolean)
              check(
                'existingEvents',
                !!found && found.saved_at === r.saved_at && jsonEqual(found.event, r.event),
                false
              )
            }
            // Payload-bearing records must survive upgrade and recovery exactly.
            for (const r of rows<RecordRow>(original, 'SELECT * FROM records')) {
              const found = stores
                .map(
                  (s) =>
                    s
                      .prepare(
                        'SELECT value FROM records WHERE conversation_id=? AND kind=? AND id=?'
                      )
                      .get(r.conversation_id, r.kind, r.id) as
                      | { event: string; value: string; saved_at: number }
                      | undefined
                )
                .find(Boolean)
              check(`existingRecords:${r.kind}`, !!found && jsonEqual(found.value, r.value), false)
            }
          } finally {
            original.close()
          }
        }
        for (const r of rows<EventRow>(baseline, 'SELECT * FROM chat_events')) {
          let found: { event: string } | undefined
          for (const store of stores) {
            found = store
              .prepare(
                "SELECT e.event FROM events e JOIN conversations c ON c.id=e.conversation_id WHERE c.tab_id=? AND e.seq=? AND c.state='active'"
              )
              .get(r.tab_id, r.seq) as
              | { event: string; value: string; saved_at: number }
              | undefined
            if (found) break
          }
          const retained = db
            .prepare('SELECT event FROM chat_events WHERE tab_id=? AND seq=?')
            .get(r.tab_id, r.seq) as { event: string; value: string; saved_at: number } | undefined
          check(
            'events',
            !!found && jsonEqual(found.event, r.event),
            !!retained && jsonEqual(retained.event, r.event)
          )
        }
        for (const r of rows<DraftRow>(baseline, 'SELECT * FROM chat_tab_state')) {
          const expected = {
            draft: {
              text: r.draft_text,
              attachments: JSON.parse(r.draft_attachments ?? '[]'),
              rev: r.rev
            },
            scroll: JSON.parse(r.scroll_anchor ?? 'null')
          }
          const retained = db.prepare('SELECT * FROM chat_tab_state WHERE tab_id=?').get(r.tab_id)
          check(
            'drafts',
            isDeepStrictEqual(record(r.tab_id, 'draft', 'state'), expected),
            isDeepStrictEqual(retained, r)
          )
        }
        for (const r of rows<QueueRow>(baseline, 'SELECT * FROM chat_queue')) {
          const expected = {
            id: r.id,
            tabId: r.tab_id,
            send: r.send,
            original: r.original,
            position: r.position,
            createdAt: r.created_at,
            ...(r.content ? { content: JSON.parse(r.content) } : {}),
            ...(r.conversation_id ? { expectedConversationId: r.conversation_id } : {})
          }
          check(
            'queue',
            isDeepStrictEqual(record(r.tab_id, 'queue', r.id), expected),
            isDeepStrictEqual(db.prepare('SELECT * FROM chat_queue WHERE id=?').get(r.id), r)
          )
        }
        for (const r of rows<PromptRow>(baseline, 'SELECT * FROM agent_prompts')) {
          const expected = {
            id: r.id,
            taskId: r.task_id,
            agentId: r.agent_id,
            cliSessionId: r.cli_session_id,
            text: r.text,
            createdAt: r.created_at
          }
          check(
            'prompts',
            taskRecord(r.task_id, 'prompt', r.id).some((v) => isDeepStrictEqual(v, expected)),
            isDeepStrictEqual(db.prepare('SELECT * FROM agent_prompts WHERE id=?').get(r.id), r)
          )
        }
        for (const r of rows<CheckpointRow>(baseline, 'SELECT * FROM chat_timeline_checkpoints')) {
          const expected = { version: r.version, seq: r.seq, data: r.data }
          check(
            'timelineCheckpoints',
            isDeepStrictEqual(record(r.tab_id, 'timeline', 'checkpoint'), expected),
            isDeepStrictEqual(
              db.prepare('SELECT * FROM chat_timeline_checkpoints WHERE tab_id=?').get(r.tab_id),
              r
            )
          )
        }
        for (const r of rows<PageRow>(baseline, 'SELECT * FROM chat_timeline_pages')) {
          const expected = {
            page: r.page,
            startRow: r.start_row,
            endRow: r.end_row,
            rows: r.rows,
            summary: r.summary,
            searchText: r.search_text
          }
          check(
            'timelinePages',
            isDeepStrictEqual(record(r.tab_id, 'timeline', `page:${r.page}`), expected),
            isDeepStrictEqual(
              db
                .prepare('SELECT * FROM chat_timeline_pages WHERE tab_id=? AND page=?')
                .get(r.tab_id, r.page),
              r
            )
          )
        }
        for (const r of rows<AttachmentMessageRow>(
          baseline,
          'SELECT * FROM chat_attachment_messages'
        ))
          check(
            'attachmentMessages',
            taskRecord(r.task_id, 'settings', `attachment-message:${r.message_id}`).some((v) =>
              isDeepStrictEqual(v, JSON.parse(r.attachments))
            ),
            isDeepStrictEqual(
              db
                .prepare('SELECT * FROM chat_attachment_messages WHERE task_id=? AND message_id=?')
                .get(r.task_id, r.message_id),
              r
            )
          )
        for (const r of rows<WorkspaceRow>(baseline, 'SELECT * FROM chat_workspace_changes')) {
          const files = JSON.parse(r.files)
          for (const file of files)
            file.diff =
              (
                baseline
                  .prepare('SELECT diff FROM chat_workspace_diffs WHERE capture_id=? AND path=?')
                  .get(r.id, file.path) as { diff: string } | undefined
              )?.diff ?? null
          const expected = {
            id: r.id,
            tabId: r.tab_id,
            messageId: r.message_id,
            computerId: r.computer_id,
            rootPath: r.root_path,
            status: r.status,
            ...(r.reason ? { reason: r.reason } : {}),
            files
          }
          check(
            'workspace',
            isDeepStrictEqual(record(r.tab_id, 'workspace', r.id), expected),
            isDeepStrictEqual(
              db.prepare('SELECT * FROM chat_workspace_changes WHERE id=?').get(r.id),
              r
            )
          )
        }
        for (const r of rows<TurnRow>(
          baseline,
          "SELECT * FROM agent_turns WHERE prompt_preview<>''"
        )) {
          const expected = {
            id: r.id,
            tabId: r.terminal_tab_id,
            worktreePath: r.worktree_path,
            snapshotSha: r.snapshot_sha,
            headShaAtSnap: r.head_sha_at_snap,
            promptPreview: r.prompt_preview,
            createdAt: r.created_at
          }
          const unassigned =
            !r.task_id &&
            !baseline.prepare('SELECT 1 FROM terminal_tabs WHERE id=?').get(r.terminal_tab_id)
          check(
            unassigned ? 'unassignedTurnPreviews' : 'turnPreviews',
            taskRecord(r.task_id, 'settings', `legacy-turn-preview:${r.id}`).some((v) =>
              isDeepStrictEqual(v, expected)
            ),
            isDeepStrictEqual(db.prepare('SELECT * FROM agent_turns WHERE id=?').get(r.id), r)
          )
        }
        if (diagnosticsBaseline && diagnosticsDb) {
          for (const r of rows<DiagnosticRow>(
            diagnosticsBaseline,
            `SELECT d.*,l.task_id AS ledger_task_id FROM diagnostics_events d JOIN chat_legacy_diagnostics l ON l.event_id=d.id WHERE NOT EXISTS(SELECT 1 FROM chat_content_locks c WHERE c.task_id=l.task_id AND c.state='cleaned')`
          )) {
            const { ledger_task_id: taskId, ...expected } = r
            if (expected.payload_json) {
              try {
                expected.payload_json = JSON.stringify(JSON.parse(expected.payload_json))
              } catch {
                /* Preserve malformed JSON verbatim. */
              }
            }
            const retained = diagnosticsDb
              .prepare('SELECT * FROM diagnostics_events WHERE id=?')
              .get(r.id)
            const original = diagnosticsBaseline
              .prepare('SELECT * FROM diagnostics_events WHERE id=?')
              .get(r.id)
            check(
              taskId ? 'diagnostics' : 'unassignedDiagnostics',
              !!taskId &&
                taskRecord(taskId, 'settings', `diagnostic:${r.id}`).some((v) =>
                  isDeepStrictEqual(v, expected)
                ),
              isDeepStrictEqual(retained, original)
            )
          }
          report.unassignedDiagnosticsAfter = await diagnostics!.unassigned()
        }
        let attachmentRecords = 0,
          missingOrCorruptBlobs = 0
        for (const storage of inspected) {
          const raw = storage.compose((d) => d)
          for (const r of rows<{ value: string }>(
            raw,
            "SELECT value FROM records WHERE kind='attachment'"
          )) {
            const ref = JSON.parse(r.value)
            attachmentRecords++
            const path = join(storage.dir, 'blobs', ref.contentHash ?? '')
            if (!ref.contentHash || !existsSync(path)) {
              missingOrCorruptBlobs++
              continue
            }
            const bytes = readFileSync(path)
            if (hash(bytes) !== ref.contentHash || bytes.length !== ref.size)
              missingOrCorruptBlobs++
          }
        }
        report.verified = verified
        report.attachmentRecords = attachmentRecords
        report.missingOrCorruptBlobs = missingOrCorruptBlobs
        report.requests = requests
        report.errors = errors
        report.ownership = db
          .prepare(
            'SELECT state,cleanup_pending,count(*) AS n FROM chat_ownership GROUP BY state,cleanup_pending'
          )
          .all()
        report.unavailableOwners = count(db, 'SELECT count(*) n FROM chat_unavailable_owners')
        report.remainingEvents = count(db, 'SELECT count(*) n FROM chat_events')
        report.foreignKeysAfter = (db.pragma('foreign_key_check') as unknown[]).length
        const integrity = [db, ...stores].map((s) => s.pragma('integrity_check', { simple: true }))
        report.integrity = integrity
        report.stage = 'complete'
        save()
        expect(
          Object.values(verified).reduce((n, v) => n + v.missingOrChanged, 0),
          'Content changed or disappeared; inspect private report'
        ).toBe(0)
        report.deferredUnassignedRecords = Object.entries(verified)
          .filter(([kind]) => kind.startsWith('unassigned'))
          .reduce((n, [, v]) => n + v.retained, 0)
        save()
        expect(
          Object.entries(verified)
            .filter(([kind]) => !kind.startsWith('unassigned'))
            .reduce((n, [, v]) => n + v.retained, 0),
          'Some attributable source content remains unmigrated; inspect private report'
        ).toBe(0)
        expect(missingOrCorruptBlobs).toBe(0)
        expect(report.foreignKeysAfter).toBeLessThanOrEqual(report.foreignKeysBefore!)
        expect(report.unavailableOwners).toBe(0)
        expect(report.forbiddenOperations).toBe(0)
        if (injectDisconnects && label !== 'dev-current') expect(injected.length).toBe(3)
        expect(integrity.every((v) => v === 'ok')).toBe(true)
        expect(Object.keys(errors).length, 'Migration errors; inspect private report').toBe(0)
      } catch (error) {
        report.failure =
          error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown failure'
        save()
        // Raw payloads, task titles and credentials never enter test output.
        throw new Error(`Private-copy audit ${label} failed; inspect its private report`)
      } finally {
        for (const storage of inspected) storage.close()
        for (const pc of pcs.values()) await pc.close()
        baseline?.close()
        diagnosticsBaseline?.close()
        diagnosticsDb?.close()
        db.close()
      }
    },
    900_000
  )
}
