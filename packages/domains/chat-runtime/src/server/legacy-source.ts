import { createHash } from 'node:crypto'
import type { SlayzoneDb, BatchOp } from '@slayzone/platform'
import type {
  ChatAttachment,
  ChatThread,
  AgentEvent,
  WorkspaceChangesRecord
} from '@slayzone/terminal-contracts'
import { userMessageAttachments } from '@slayzone/terminal-contracts'
import type {
  ChatRecord,
  ChatTransferHeader,
  ChatTransferManifest,
  StoredChatEvent
} from '../shared'
import type { ChatBootstrap } from './local-data'
import type { HubChatOwnership } from './hub-ownership'
import type { ChatMigrationSource } from './migration'
import { TRANSFER_CHUNK_BYTES } from './transfers'

type Item = { kind: 'event'; value: StoredChatEvent } | { kind: 'record'; value: ChatRecord }

/** Reads existing hub history without creating another on-disk hub copy. */
export function createLegacyChatSource(opts: {
  db: SlayzoneDb
  quiesce(owner: HubChatOwnership): Promise<void>
  bootstrap(owner: HubChatOwnership): Promise<ChatBootstrap>
  readAttachment(owner: HubChatOwnership, ref: ChatAttachment): Promise<Uint8Array>
}): ChatMigrationSource {
  const { db } = opts
  async function* rows<T>(sql: string, params: unknown[]): AsyncGenerator<T> {
    let after = 0
    for (;;) {
      const batch = await db.all<T & { _rowid: number }>(
        `SELECT * FROM (${sql}) WHERE _rowid>? ORDER BY _rowid LIMIT 256`,
        [...params, after]
      )
      if (!batch.length) return
      for (const row of batch) {
        after = row._rowid
        yield row as Awaited<T>
      }
    }
  }
  async function leader(taskId: string) {
    return (
      await db.get<{ id: string }>(
        `SELECT id FROM terminal_tabs WHERE task_id=? AND mode IN ('claude-chat','codex-chat') AND NOT EXISTS(SELECT 1 FROM chat_threads WHERE id=terminal_tabs.id) ORDER BY created_at,id LIMIT 1`,
        [taskId]
      )
    )?.id
  }
  async function* items(owner: HubChatOwnership, bootstrap: ChatBootstrap): AsyncGenerator<Item> {
    const record = (kind: ChatRecord['kind'], id: string, value: unknown, at = 0): Item => ({
      kind: 'record',
      value: { kind, id, value, at }
    })
    const refs = new Map<string, ChatAttachment>()
    const remember = (attachments: ChatAttachment[]) => {
      for (const ref of attachments) refs.set(`${ref.artifactId}:${ref.contentHash ?? ''}`, ref)
    }
    yield record('settings', 'bootstrap', bootstrap)
    yield record('settings', 'provider', bootstrap.providerConfig)
    const canonicalMode =
      owner.mode === 'claude-chat'
        ? 'claude-code'
        : owner.mode === 'codex-chat'
          ? 'codex'
          : owner.mode
    const task = await db.get<{ provider_config: string | null; project_id: string | null }>(
      'SELECT provider_config,project_id FROM tasks WHERE id=?',
      [owner.taskId]
    )
    const config = JSON.parse(task?.provider_config ?? '{}')
    yield record('settings', `provider:${canonicalMode}`, config[canonicalMode] ?? {})
    for await (const r of rows<{
      conversation_id: string
      mode: string
      origin: string
      created_at: number
    }>(
      `SELECT rowid AS _rowid,* FROM task_conversations WHERE task_id=? AND conversation_id IS NOT NULL AND origin NOT IN ('foreign-observed','pending-spawn')`,
      [owner.taskId]
    ))
      yield record(
        'settings',
        `session:${r.conversation_id}`,
        { taskId: owner.taskId, mode: r.mode, conversationId: r.conversation_id, origin: r.origin },
        r.created_at
      )
    if (task?.project_id) {
      const snapshot = await db.get<{
        slash_commands: string
        terminal_slash_commands: string
        skills: string
        cli_version: string | null
      }>('SELECT * FROM chat_cli_snapshots WHERE project_id=? AND mode=?', [
        task.project_id,
        owner.mode
      ])
      if (snapshot)
        yield record('settings', 'cli-snapshot', {
          slashCommands: JSON.parse(snapshot.slash_commands),
          terminalSlashCommands: JSON.parse(snapshot.terminal_slash_commands),
          skills: JSON.parse(snapshot.skills),
          cliVersion: snapshot.cli_version
        })
      for (const [table, column, key] of [
        ['chat_cli_command_details', 'details', 'cli-details'],
        ['chat_cli_models', 'models', 'cli-models']
      ]) {
        const row = await db.get<Record<string, string>>(
          `SELECT ${column} FROM ${table} WHERE project_id=? AND mode=?`,
          [task.project_id, owner.mode]
        )
        if (row) yield record('settings', key, JSON.parse(row[column]))
      }
    }

    for await (const r of rows<{
      seq: number
      event: string
      saved_at: number | null
      created_at: string
    }>('SELECT seq+1 AS _rowid,* FROM chat_events WHERE tab_id=?', [owner.tabId])) {
      const event = JSON.parse(r.event) as AgentEvent
      if (event.kind === 'user-message') remember(userMessageAttachments(event.content ?? []))
      yield {
        kind: 'event',
        value: { seq: r.seq, at: r.saved_at ?? Date.parse(r.created_at + 'Z'), event }
      }
    }
    const draft = await db.get<{
      draft_text: string
      draft_attachments: string | null
      scroll_anchor: string | null
      rev: number
      updated_at: number
    }>('SELECT * FROM chat_tab_state WHERE tab_id=?', [owner.tabId])
    if (draft) {
      const attachments = JSON.parse(draft.draft_attachments ?? '[]') as ChatAttachment[]
      remember(attachments)
      yield record(
        'draft',
        'state',
        {
          draft: { text: draft.draft_text, attachments, rev: draft.rev },
          scroll: JSON.parse(draft.scroll_anchor ?? 'null')
        },
        draft.updated_at
      )
    }
    for await (const r of rows<{
      id: string
      send: string
      original: string
      position: number
      created_at: string
      content: string | null
      conversation_id: string | null
    }>('SELECT rowid AS _rowid,* FROM chat_queue WHERE tab_id=?', [owner.tabId])) {
      const content = JSON.parse(r.content ?? '[]')
      remember(userMessageAttachments(content))
      yield record(
        'queue',
        r.id,
        {
          id: r.id,
          tabId: owner.tabId,
          send: r.send,
          original: r.original,
          position: r.position,
          createdAt: r.created_at,
          ...(r.content ? { content } : {}),
          ...(r.conversation_id ? { expectedConversationId: r.conversation_id } : {})
        },
        Date.parse(r.created_at + 'Z')
      )
    }
    const checkpoint = await db.get<{ version: string; seq: number; data: string }>(
      'SELECT version,seq,data FROM chat_timeline_checkpoints WHERE tab_id=?',
      [owner.tabId]
    )
    if (checkpoint) yield record('timeline', 'checkpoint', checkpoint)
    for await (const r of rows<{
      page: number
      start_row: number
      end_row: number
      rows: string
      summary: string
      search_text: string
    }>('SELECT rowid AS _rowid,* FROM chat_timeline_pages WHERE tab_id=?', [owner.tabId]))
      yield record('timeline', `page:${r.page}`, {
        page: r.page,
        startRow: r.start_row,
        endRow: r.end_row,
        rows: r.rows,
        summary: r.summary,
        searchText: r.search_text
      })
    for await (const r of rows<ChatThread>(
      `SELECT rowid AS _rowid,id,parent_tab_id AS parentTabId,task_id AS taskId,mode,parent_conversation_id AS parentConversationId,answer_id AS answerId,source_message_id AS sourceMessageId,source_uuid AS sourceUuid,title,conversation_id AS conversationId,created_at AS createdAt FROM chat_threads WHERE parent_tab_id=?`,
      [owner.tabId]
    )) {
      const { _rowid, ...thread } = r as ChatThread & { _rowid: number }
      yield record('thread', thread.id, thread, thread.createdAt)
    }
    const parent = await db.get<{ parent_tab_id: string }>(
      'SELECT parent_tab_id FROM chat_threads WHERE id=?',
      [owner.tabId]
    )
    if (parent) yield record('settings', 'thread-parent', parent.parent_tab_id)
    for await (const r of rows<{
      id: string
      message_id: string
      computer_id: string | null
      root_path: string
      status: WorkspaceChangesRecord['status']
      reason: string | null
      files: string
      created_at: number
    }>('SELECT rowid AS _rowid,* FROM chat_workspace_changes WHERE tab_id=?', [owner.tabId])) {
      const files = JSON.parse(r.files) as WorkspaceChangesRecord['files']
      for (const file of files) {
        file.diff =
          (
            await db.get<{ diff: string }>(
              'SELECT diff FROM chat_workspace_diffs WHERE capture_id=? AND path=?',
              [r.id, file.path]
            )
          )?.diff ?? null
      }
      yield record(
        'workspace',
        r.id,
        {
          id: r.id,
          tabId: owner.tabId,
          messageId: r.message_id,
          computerId: r.computer_id,
          rootPath: r.root_path,
          status: r.status,
          ...(r.reason ? { reason: r.reason } : {}),
          files
        },
        r.created_at
      )
    }
    if (
      owner.tabId === (await leader(owner.taskId)) ||
      owner.tabId === `prompt-history:${owner.taskId}`
    ) {
      for await (const r of rows<{
        id: string
        agent_id: string
        cli_session_id: string | null
        text: string
        created_at: number
      }>('SELECT rowid AS _rowid,* FROM agent_prompts WHERE task_id=?', [owner.taskId]))
        yield record(
          'prompt',
          r.id,
          {
            id: r.id,
            taskId: owner.taskId,
            agentId: r.agent_id,
            cliSessionId: r.cli_session_id,
            text: r.text,
            createdAt: r.created_at
          },
          r.created_at
        )
      for await (const r of rows<{ message_id: string; attachments: string }>(
        'SELECT rowid AS _rowid,* FROM chat_attachment_messages WHERE task_id=?',
        [owner.taskId]
      )) {
        const attachments = JSON.parse(r.attachments) as ChatAttachment[]
        remember(attachments)
        yield record('settings', `attachment-message:${r.message_id}`, attachments)
      }
    }
    // A sealed reference pins the historical version, independent of later artifact edits.
    for (const ref of refs.values()) {
      const version = ref.contentHash
        ? { content_hash: ref.contentHash }
        : await db.get<{ content_hash: string }>(
            `SELECT v.content_hash FROM task_artifacts a JOIN artifact_versions v ON v.id=a.current_version_id WHERE a.id=? AND a.task_id=?`,
            [ref.artifactId, owner.taskId]
          )
      if (!version?.content_hash) throw new Error('Migration attachment version is missing')
      const sealed = { ...ref, contentHash: version.content_hash, taskId: owner.taskId }
      yield record('attachment', `${ref.artifactId}:${version.content_hash}`, sealed)
    }
  }
  return {
    quiesce: opts.quiesce,
    readAttachment: opts.readAttachment,
    async open(owner, migrationId) {
      if (owner.computerId) throw new Error('Legacy source cannot export computer-owned history')
      const bootstrap = await opts.bootstrap(owner)
      const header: ChatTransferHeader = {
        format: 'slayzone-chat',
        version: 1,
        migrationId,
        identity: {
          id: owner.id,
          taskId: owner.taskId,
          tabId: owner.tabId,
          mode: owner.mode,
          epoch: owner.epoch
        },
        events: 0,
        records: 0,
        receipts: 0
      }
      for await (const item of items(owner, bootstrap)) {
        if (item.kind === 'event') header.events++
        else header.records++
      }
      async function* buffers() {
        yield Buffer.from(JSON.stringify(header) + '\n')
        for await (const item of items(owner, bootstrap))
          yield Buffer.from(JSON.stringify(item) + '\n')
      }
      const hash = createHash('sha256')
      let bytes = 0
      for await (const b of buffers()) {
        hash.update(b)
        bytes += b.length
      }
      const manifest: ChatTransferManifest = { header, bytes, hash: hash.digest('hex') }
      return {
        manifest,
        async *chunks(offset: number) {
          let skipped = 0,
            pending = Buffer.alloc(0)
          for await (const b of buffers()) {
            const end = skipped + b.length
            if (end <= offset) {
              skipped = end
              continue
            }
            const rest = b.subarray(Math.max(0, offset - skipped))
            skipped = end
            let cursor = 0
            while (cursor < rest.length) {
              const n = Math.min(TRANSFER_CHUNK_BYTES - pending.length, rest.length - cursor)
              pending = Buffer.concat([pending, rest.subarray(cursor, cursor + n)])
              cursor += n
              if (pending.length === TRANSFER_CHUNK_BYTES) {
                yield pending
                pending = Buffer.alloc(0)
              }
            }
          }
          if (pending.length) yield pending
        }
      }
    },
    async cleanup(owner) {
      if (
        owner.state !== 'active' ||
        !owner.cleanupPending ||
        !owner.migrationId ||
        !owner.manifestHash ||
        owner.sourceComputerId !== null
      )
        throw new Error('Legacy cleanup requires committed migration')
      const authoritative = await db.get<{ epoch: number; state: string; migration_id: string }>(
        'SELECT epoch,state,migration_id FROM chat_ownership WHERE id=?',
        [owner.id]
      )
      if (
        authoritative?.epoch !== owner.epoch ||
        authoritative.state !== 'active' ||
        authoritative.migration_id !== owner.migrationId
      )
        throw new Error('Legacy cleanup ownership changed')
      await db.get('PRAGMA secure_delete=ON')
      const ops: BatchOp[] = [
        'chat_events',
        'chat_queue',
        'chat_tab_state',
        'chat_timeline_pages',
        'chat_timeline_checkpoints',
        'chat_workspace_changes'
      ].map((table) => ({
        type: 'run',
        sql: `DELETE FROM ${table} WHERE tab_id=?`,
        params: [owner.tabId]
      }))
      if (
        owner.tabId === (await leader(owner.taskId)) ||
        owner.tabId === `prompt-history:${owner.taskId}`
      ) {
        ops.push(
          { type: 'run', sql: 'DELETE FROM agent_prompts WHERE task_id=?', params: [owner.taskId] },
          {
            type: 'run',
            sql: 'DELETE FROM chat_attachment_messages WHERE task_id=?',
            params: [owner.taskId]
          },
          {
            type: 'run',
            sql: "UPDATE agent_turns SET prompt_preview='' WHERE task_id=?",
            params: [owner.taskId]
          }
        )
      }
      // Keep thread ids for authorization and hidden-tab lifetime; content stays local.
      ops.push(
        {
          type: 'run',
          sql: `UPDATE chat_threads SET title='Thread' WHERE task_id=? AND EXISTS(SELECT 1 FROM chat_tab_bindings b JOIN chat_ownership o ON o.id=b.conversation_id WHERE b.tab_id=chat_threads.parent_tab_id AND o.state='active')`,
          params: [owner.taskId]
        },
        {
          type: 'run',
          sql: "UPDATE terminal_tabs SET label='Thread' WHERE task_id=? AND id IN(SELECT id FROM chat_threads WHERE title='Thread')",
          params: [owner.taskId]
        }
      )
      await db.batchTxn(ops)
      const checkpoint = await db.get<{ busy: number }>('PRAGMA wal_checkpoint(TRUNCATE)')
      if (checkpoint?.busy) throw new Error('Hub cleanup checkpoint is busy; retry cleanup')
    }
  }
}
