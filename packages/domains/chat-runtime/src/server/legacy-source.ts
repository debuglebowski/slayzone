import { createHash } from 'node:crypto'
import type { SlayzoneDb, BatchOp } from '@slayzone/platform'
import type {
  ChatAttachment,
  ChatThread,
  AgentEvent,
  WorkspaceChangesRecord,
  ChatTabState,
  QueuedChatMessage
} from '@slayzone/terminal-contracts'
import type {
  ChatRecord,
  ChatTransferHeader,
  ChatTransferManifest,
  StoredChatEvent
} from '../shared'
import { sessionRecordKey, type ChatBootstrap } from './local-data'
import type { HubChatOwnership } from './hub-ownership'
import type { ChatMigrationSource } from './migration'
import { TRANSFER_CHUNK_BYTES } from './transfers'
import { legacyChatTabContentSql } from './legacy-census'
import { legacySessionAuthority } from './legacy-session-authority'
import { migrationAttachmentScope } from './migration-attachments'
import {
  LEGACY_CHAT_BLOB_PIN_SCOPE,
  type MigrationAttachmentScope
} from './migration-attachment-txns'

const timestamp = (value: string) =>
  Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? value : value + 'Z')

type Item = { kind: 'event'; value: StoredChatEvent } | { kind: 'record'; value: ChatRecord }

export interface LegacyChatDiagnostics {
  freeze(taskId: string): Promise<number>
  records(taskId: string, cutoff: number): AsyncIterable<ChatRecord>
  cleanup(taskId: string, cutoff: number): Promise<void>
  tasks(): Promise<string[]>
  hasTask?(taskId: string): Promise<boolean>
}

/** Reads existing hub history without creating another on-disk hub copy. */
export function createLegacyChatSource(opts: {
  db: SlayzoneDb
  diagnostics?: LegacyChatDiagnostics
  quiesce(owner: HubChatOwnership): Promise<void>
  bootstrap(owner: HubChatOwnership): Promise<ChatBootstrap>
  freezeMetadata?(
    owner: HubChatOwnership,
    migrationId: string,
    candidate?: ChatRecord[]
  ): Promise<ChatRecord[] | null>
  readAttachment(owner: HubChatOwnership, ref: ChatAttachment): Promise<Uint8Array>
  readPinnedAttachment?(scope: MigrationAttachmentScope, ref: ChatAttachment): Promise<Uint8Array>
  collectReleasedAttachments?(): Promise<unknown>
  resolveSessionComputer?(owner: HubChatOwnership): Promise<string | null>
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
        `SELECT id FROM terminal_tabs WHERE task_id=? AND (mode IN ('claude-chat','codex-chat') OR ${legacyChatTabContentSql('terminal_tabs')}
          OR EXISTS(SELECT 1 FROM chat_tab_bindings b JOIN chat_ownership o ON o.id=b.conversation_id
            WHERE b.tab_id=terminal_tabs.id AND o.state<>'deleted'))
          AND NOT EXISTS(SELECT 1 FROM chat_threads WHERE id=terminal_tabs.id) ORDER BY created_at,id LIMIT 1`,
        [taskId]
      )
    )?.id
  }
  const taskAuthorityKey = 'legacy-task-content-authority'
  async function includesTaskContent(owner: HubChatOwnership) {
    const authority = await db.get<{ conversation_id: string }>(
      'SELECT conversation_id FROM chat_legacy_task_authority WHERE task_id=?',
      [owner.taskId]
    )
    return authority
      ? authority.conversation_id === owner.id
      : owner.tabId === `prompt-history:${owner.taskId}` ||
          owner.tabId === (await leader(owner.taskId))
  }
  function frozenTaskContent(metadata: ChatRecord[]): boolean | undefined {
    const marker = metadata.find((r) => r.kind === 'settings' && r.id === taskAuthorityKey)
    return marker ? marker.value === true : undefined
  }
  const record = (kind: ChatRecord['kind'], id: string, value: unknown, at = 0): Item => ({
    kind: 'record',
    value: { kind, id, value, at }
  })
  async function* mutableMetadata(
    owner: HubChatOwnership,
    bootstrap: ChatBootstrap
  ): AsyncGenerator<Item> {
    const taskContent = await includesTaskContent(owner)
    if (owner.tabId === `task-content:${owner.taskId}`) yield record('settings', 'inbox', true)
    yield record('settings', taskAuthorityKey, taskContent)
    if (opts.diagnostics && taskContent)
      yield record(
        'settings',
        'legacy-diagnostics-cutoff',
        await opts.diagnostics.freeze(owner.taskId)
      )
    yield record('settings', 'bootstrap', bootstrap)
    const storageOnly = owner.tabId === `task-content:${owner.taskId}`
    if (!storageOnly) yield record('settings', 'provider', bootstrap.providerConfig)
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
    if (!storageOnly)
      yield record('settings', `provider:${canonicalMode}`, config[canonicalMode] ?? {})
    for await (const r of rows<{
      conversation_id: string
      mode: string
      origin: string
      created_at: number
    }>(
      `SELECT rowid AS _rowid,* FROM task_conversations c WHERE task_id=? AND conversation_id IS NOT NULL AND origin NOT IN ('foreign-observed','pending-spawn') AND rowid=(SELECT max(d.rowid) FROM task_conversations d WHERE d.task_id=c.task_id AND d.mode=c.mode AND d.conversation_id=c.conversation_id AND d.origin NOT IN ('foreign-observed','pending-spawn'))`,
      [owner.taskId]
    ))
      yield record(
        'settings',
        sessionRecordKey(r.mode, r.conversation_id),
        {
          taskId: owner.taskId,
          mode: r.mode,
          conversationId: r.conversation_id,
          origin: r.origin,
          createdAt: r.created_at,
          ownershipClaim:
            (await legacySessionAuthority(
              db,
              owner.taskId,
              r.mode,
              r.conversation_id,
              opts.resolveSessionComputer
            )) === owner.id
        },
        r.created_at
      )
    for (const r of await db.all<{ mode: string; created_at: number }>(
      'SELECT mode,max(created_at) AS created_at FROM session_resets WHERE task_id=? GROUP BY mode',
      [owner.taskId]
    ))
      yield record(
        'settings',
        `session:reset:${r.mode}`,
        {
          taskId: owner.taskId,
          mode: r.mode,
          conversationId: null,
          origin: 'manual-reset',
          createdAt: r.created_at
        },
        r.created_at
      )
    if (task?.project_id && !storageOnly) {
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
  }
  async function* rawItems(owner: HubChatOwnership, metadata: ChatRecord[]): AsyncGenerator<Item> {
    for (const value of metadata) yield { kind: 'record', value }
    for await (const r of eventRows(owner.tabId)) {
      const event = JSON.parse(r.event) as AgentEvent
      yield {
        kind: 'event',
        value: { seq: r.seq, at: r.saved_at ?? timestamp(r.created_at), event }
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
        timestamp(r.created_at)
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
    if (frozenTaskContent(metadata) ?? (await includesTaskContent(owner))) {
      const cutoff = metadata.find(
        (r) => r.kind === 'settings' && r.id === 'legacy-diagnostics-cutoff'
      )?.value
      if (opts.diagnostics && typeof cutoff === 'number')
        for await (const value of opts.diagnostics.records(owner.taskId, cutoff))
          yield { kind: 'record', value }
      for await (const r of rows<{
        id: string
        terminal_tab_id: string
        worktree_path: string
        snapshot_sha: string
        head_sha_at_snap: string | null
        prompt_preview: string
        created_at: number
      }>("SELECT rowid AS _rowid,* FROM agent_turns WHERE task_id=? AND prompt_preview<>''", [
        owner.taskId
      ]))
        yield record(
          'settings',
          `legacy-turn-preview:${r.id}`,
          {
            id: r.id,
            tabId: r.terminal_tab_id,
            worktreePath: r.worktree_path,
            snapshotSha: r.snapshot_sha,
            headShaAtSnap: r.head_sha_at_snap,
            promptPreview: r.prompt_preview,
            createdAt: r.created_at
          },
          r.created_at
        )
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
        yield record('settings', `attachment-message:${r.message_id}`, attachments)
      }
    }
  }
  async function* eventRows(tabId: string) {
    let after = -1
    for (;;) {
      const batch = await db.all<{
        seq: number
        event: string
        saved_at: number | null
        created_at: string
      }>(
        'SELECT seq,event,saved_at,created_at FROM chat_events WHERE tab_id=? AND seq>? ORDER BY seq LIMIT 256',
        [tabId, after]
      )
      if (!batch.length) return
      for (const row of batch) {
        after = row.seq
        yield row
      }
    }
  }
  const attachmentKey = (ref: ChatAttachment) => `${ref.artifactId}:${ref.contentHash ?? ''}`
  function visitItem(item: Item, attachment: (ref: ChatAttachment) => ChatAttachment): Item {
    const content = (blocks: import('@slayzone/terminal-contracts').UserContentBlock[]) =>
      blocks.map((block) =>
        block.type === 'attachment' ? { ...block, attachment: attachment(block.attachment) } : block
      )
    if (item.kind === 'event') {
      const event = item.value.event
      return event.kind === 'user-message' && event.content
        ? {
            ...item,
            value: { ...item.value, event: { ...event, content: content(event.content) } }
          }
        : item
    }
    if (item.value.kind === 'draft') {
      const value = item.value.value as ChatTabState
      return {
        ...item,
        value: {
          ...item.value,
          value: {
            ...value,
            draft: { ...value.draft, attachments: value.draft.attachments.map(attachment) }
          }
        }
      }
    }
    if (item.value.kind === 'queue') {
      const value = item.value.value as QueuedChatMessage
      return value.content
        ? {
            ...item,
            value: { ...item.value, value: { ...value, content: content(value.content) } }
          }
        : item
    }
    if (item.value.kind === 'settings' && item.value.id.startsWith('attachment-message:'))
      return {
        ...item,
        value: { ...item.value, value: (item.value.value as ChatAttachment[]).map(attachment) }
      }
    if (item.kind === 'record' && item.value.kind === 'timeline') {
      const value = { ...(item.value.value as Record<string, unknown>) }
      for (const key of ['rows', 'data'])
        if (typeof value[key] === 'string') {
          let changed = false
          const row = (input: unknown) => {
            if (!input || typeof input !== 'object') return input
            const record = input as Record<string, unknown>
            if (record.kind !== 'user-text' || !Array.isArray(record.attachments)) return input
            return {
              ...record,
              attachments: record.attachments.map((ref: ChatAttachment) => {
                const next = attachment(ref)
                changed ||= next !== ref
                return next
              })
            }
          }
          const decoded = JSON.parse(value[key]) as unknown
          let mapped = decoded
          if (key === 'rows' && Array.isArray(decoded)) mapped = decoded.map(row)
          else if (key === 'data' && decoded && typeof decoded === 'object') {
            const checkpoint = decoded as Record<string, unknown>
            mapped = {
              ...checkpoint,
              ...(Array.isArray(checkpoint.tail) ? { tail: checkpoint.tail.map(row) } : {}),
              ...(Array.isArray(checkpoint.timeline)
                ? { timeline: checkpoint.timeline.map(row) }
                : {})
            }
          }
          if (changed) value[key] = JSON.stringify(mapped)
        }
      return { ...item, value: { ...item.value, value } }
    }
    return item
  }
  type AttachmentMap = Record<string, ChatAttachment>
  async function attachmentManifest(
    owner: HubChatOwnership,
    metadata: ChatRecord[],
    migrationId: string
  ): Promise<AttachmentMap> {
    const refs = new Map<string, ChatAttachment>()
    for await (const item of rawItems(owner, metadata))
      visitItem(item, (ref) => {
        refs.set(attachmentKey(ref), ref)
        return ref
      })
    if (!refs.size) return {}
    const sealed = await db.namedTxn('chat-migration:pin-attachments', {
      scope: await migrationAttachmentScope(db, owner, migrationId),
      refs: [...refs.values()]
    })
    return Object.fromEntries([...refs.keys()].map((key, index) => [key, sealed[index]]))
  }
  async function* items(owner: HubChatOwnership, metadata: ChatRecord[]): AsyncGenerator<Item> {
    const mapping = metadata.find(
      (r) => r.kind === 'settings' && r.id === 'legacy-attachment-manifest'
    )?.value as AttachmentMap | undefined
    if (!mapping) throw new Error('Migration attachment manifest is missing')
    for await (const item of rawItems(owner, metadata))
      if (
        !(
          item.kind === 'record' &&
          item.value.kind === 'settings' &&
          item.value.id === 'legacy-attachment-manifest'
        )
      )
        yield visitItem(item, (ref) => {
          // The map may itself contain already sealed references.
          const sealed =
            mapping[attachmentKey(ref)] ??
            Object.values(mapping).find(
              (r) => r.artifactId === ref.artifactId && r.contentHash === ref.contentHash
            )
          if (!sealed) throw new Error('Migration attachment reference changed after checkpoint')
          return { ...ref, contentHash: sealed.contentHash, size: sealed.size }
        })
    const emitted = new Set<string>()
    for (const ref of Object.values(mapping)) {
      const key = attachmentKey(ref)
      if (emitted.has(key)) continue
      emitted.add(key)
      yield record('attachment', key, { ...ref, taskId: owner.taskId })
    }
  }
  const source: ChatMigrationSource = {
    quiesce: opts.quiesce,
    async pinAttachments(owner, refs) {
      if (!refs.length) return
      const scope = await migrationAttachmentScope(db, owner)
      const validate = async () => {
        for (const ref of refs)
          await db.namedTxn('chat-migration:read-attachment-pin', { scope, ref })
      }
      try {
        await validate()
      } catch (error) {
        const existing = await db.get(
          `SELECT 1 FROM artifact_blob_pins WHERE scope=? AND owner_id=? AND token=? LIMIT 1`,
          [LEGACY_CHAT_BLOB_PIN_SCOPE, owner.id, scope.migrationId]
        )
        if (existing) throw error // An established frozen scope cannot grow from a remote missing-list.
        // Historical prepared transfers used bare embedded refs and no frozen
        // map. Prove membership from genuine local source containers instead of
        // rewriting their already verified transfer stream/checkpoint.
        const metadata = (await opts.freezeMetadata?.(owner, scope.migrationId)) ?? []
        const genuine: ChatAttachment[] = []
        for await (const item of rawItems(owner, metadata))
          visitItem(item, (ref) => {
            genuine.push(ref)
            return ref
          })
        const mapping = metadata.find(
          (record) => record.kind === 'settings' && record.id === 'legacy-attachment-manifest'
        )?.value as AttachmentMap | undefined
        for (const requested of refs) {
          const member = genuine.find(
            (candidate) =>
              candidate.artifactId === requested.artifactId &&
              (!candidate.contentHash || candidate.contentHash === requested.contentHash) &&
              (!mapping || mapping[attachmentKey(candidate)]?.contentHash === requested.contentHash)
          )
          if (!member) throw new Error('Prepared attachment is outside this frozen source')
        }
        // This still requires artifact/task/version provenance for every new
        // pin. An arbitrary hash from a remote missing-list grants no access.
        await db.namedTxn('chat-migration:pin-attachments', { scope, refs })
        await validate()
      }
    },
    async readAttachment(owner, ref) {
      const scope = await migrationAttachmentScope(db, owner)
      await db.namedTxn('chat-migration:read-attachment-pin', { scope, ref })
      return opts.readPinnedAttachment
        ? opts.readPinnedAttachment(scope, ref)
        : opts.readAttachment(owner, ref)
    },
    async open(owner, migrationId) {
      if (owner.computerId) throw new Error('Legacy source cannot export computer-owned history')
      let metadata = (await opts.freezeMetadata?.(owner, migrationId)) ?? null
      if (!metadata) {
        const candidate: ChatRecord[] = []
        for await (const item of mutableMetadata(owner, await opts.bootstrap(owner)))
          if (item.kind === 'record') candidate.push(item.value)
        candidate.push({
          kind: 'settings',
          id: 'legacy-attachment-manifest',
          value: await attachmentManifest(owner, candidate, migrationId),
          at: 0
        })
        metadata = (await opts.freezeMetadata?.(owner, migrationId, candidate)) ?? candidate
      }
      if (frozenTaskContent(metadata) === undefined) {
        const upgraded = [
          ...metadata,
          {
            kind: 'settings' as const,
            id: taskAuthorityKey,
            value: await includesTaskContent(owner),
            at: 0
          }
        ]
        metadata = (await opts.freezeMetadata?.(owner, migrationId, upgraded)) ?? upgraded
        if (frozenTaskContent(metadata) === undefined)
          throw new Error(
            'Computer cannot freeze task content ownership; update it before retrying migration'
          )
      }
      if (!metadata.some((r) => r.kind === 'settings' && r.id === 'legacy-attachment-manifest')) {
        const upgraded: ChatRecord[] = [
          ...metadata,
          {
            kind: 'settings',
            id: 'legacy-attachment-manifest',
            value: await attachmentManifest(owner, metadata, migrationId),
            at: 0
          }
        ]
        metadata = (await opts.freezeMetadata?.(owner, migrationId, upgraded)) ?? upgraded
        if (!metadata.some((r) => r.kind === 'settings' && r.id === 'legacy-attachment-manifest'))
          throw new Error(
            'Computer cannot freeze the legacy attachment manifest; update the computer before retrying migration'
          )
      }
      const mapping = metadata.find(
        (record) => record.kind === 'settings' && record.id === 'legacy-attachment-manifest'
      )!.value as AttachmentMap
      const originals = new Map<string, ChatAttachment>()
      for await (const item of rawItems(owner, metadata))
        visitItem(item, (ref) => {
          originals.set(attachmentKey(ref), ref)
          return ref
        })
      for (const key of Object.keys(mapping))
        if (!originals.has(key)) {
          // An older checkpoint may also have copied task-wide history before
          // it gained an independent authority. Its established source pin is
          // proof for that frozen reference even after the task scope cleans up.
          await db.namedTxn('chat-migration:read-attachment-pin', {
            scope: await migrationAttachmentScope(db, owner, migrationId),
            ref: mapping[key]
          })
        }
      const expected = [...originals].map(([key, ref]) => {
        const pinned = mapping[key]
        if (!pinned?.contentHash || pinned.artifactId !== ref.artifactId)
          throw new Error('Frozen attachment map is incomplete or changed')
        return { contentHash: pinned.contentHash, size: pinned.size }
      })
      if (originals.size)
        await db.namedTxn('chat-migration:pin-attachments', {
          scope: await migrationAttachmentScope(db, owner, migrationId),
          refs: [...originals.values()],
          expected
        })
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
      for await (const item of items(owner, metadata!)) {
        if (item.kind === 'event') header.events++
        else header.records++
      }
      const copied: Array<{ kind: string; id: string }> = []
      async function* buffers(proof = false) {
        yield Buffer.from(JSON.stringify(header) + '\n')
        for await (const item of items(owner, metadata!)) {
          if (proof && frozenTaskContent(metadata!) && item.kind === 'record') {
            const r = item.value
            if (r.kind === 'prompt') copied.push({ kind: 'prompt', id: r.id })
            if (r.kind === 'settings') {
              if (r.id.startsWith('attachment-message:'))
                copied.push({ kind: 'attachment-message', id: r.id.slice(19) })
              if (r.id.startsWith('legacy-turn-preview:'))
                copied.push({ kind: 'turn-preview', id: r.id.slice(20) })
              if (r.id === 'legacy-diagnostics-cutoff' && typeof r.value === 'number')
                copied.push({ kind: 'diagnostics-cutoff', id: String(r.value) })
            }
          }
          yield Buffer.from(JSON.stringify(item) + '\n')
        }
      }
      const hash = createHash('sha256')
      let bytes = 0
      for await (const b of buffers(true)) {
        hash.update(b)
        bytes += b.length
      }
      const manifest: ChatTransferManifest = { header, bytes, hash: hash.digest('hex') }
      await db.batchTxn([
        {
          type: 'run',
          sql: 'DELETE FROM chat_legacy_task_copies WHERE conversation_id=? AND migration_id=?',
          params: [owner.id, migrationId]
        },
        ...copied.map((r) => ({
          type: 'run' as const,
          sql: 'INSERT INTO chat_legacy_task_copies VALUES(?,?,?,?,?)',
          params: [owner.id, migrationId, manifest.hash, r.kind, r.id]
        }))
      ])
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
      // A terminal tab can close at any phase. Only source IDs actually present
      // in this verified stream authorize task-wide cleanup; never elect a new
      // leader here. Historical prepared streams without this ledger retain
      // their source until the independent task-content conversation copies it.
      const proofParams = [owner.id, owner.migrationId, owner.manifestHash]
      const diagnostics = await db.get<{ source_id: string }>(
        "SELECT source_id FROM chat_legacy_task_copies WHERE conversation_id=? AND migration_id=? AND manifest_hash=? AND kind='diagnostics-cutoff'",
        proofParams
      )
      const diagnosticsCutoff = diagnostics ? Number(diagnostics.source_id) : null
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
      ops.push(
        {
          type: 'run',
          sql: "DELETE FROM agent_prompts WHERE task_id=? AND id IN(SELECT source_id FROM chat_legacy_task_copies WHERE conversation_id=? AND migration_id=? AND manifest_hash=? AND kind='prompt')",
          params: [owner.taskId, ...proofParams]
        },
        {
          type: 'run',
          sql: "DELETE FROM chat_attachment_messages WHERE task_id=? AND message_id IN(SELECT source_id FROM chat_legacy_task_copies WHERE conversation_id=? AND migration_id=? AND manifest_hash=? AND kind='attachment-message')",
          params: [owner.taskId, ...proofParams]
        },
        {
          type: 'run',
          sql: "UPDATE agent_turns SET prompt_preview='' WHERE task_id=? AND id IN(SELECT source_id FROM chat_legacy_task_copies WHERE conversation_id=? AND migration_id=? AND manifest_hash=? AND kind='turn-preview')",
          params: [owner.taskId, ...proofParams]
        }
      )
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
      for (const table of ['chat_cli_snapshots', 'chat_cli_models', 'chat_cli_command_details'])
        ops.push({
          type: 'run',
          sql: `DELETE FROM ${table} WHERE project_id=(SELECT project_id FROM tasks WHERE id=?) AND mode=? AND NOT EXISTS(SELECT 1 FROM terminal_tabs t JOIN tasks task ON task.id=t.task_id LEFT JOIN chat_tab_bindings b ON b.tab_id=t.id LEFT JOIN chat_ownership o ON o.id=b.conversation_id WHERE task.project_id=(SELECT project_id FROM tasks WHERE id=?)
            AND COALESCE(o.mode,CASE t.mode WHEN 'claude-code' THEN 'claude-chat' WHEN 'codex' THEN 'codex-chat' ELSE t.mode END)=?
            AND (o.state IS NULL OR o.state NOT IN ('active','deleted')))`,
          params: [owner.taskId, owner.mode, owner.taskId, owner.mode]
        })
      ops.push({
        type: 'run',
        sql: 'DELETE FROM artifact_blob_pins WHERE scope=? AND owner_id=? AND token=?',
        params: [LEGACY_CHAT_BLOB_PIN_SCOPE, owner.id, owner.migrationId]
      })
      ops.push({
        type: 'run',
        sql: 'INSERT OR IGNORE INTO artifact_blob_gc_pending VALUES(1)',
        params: []
      })
      ops.push({
        type: 'run',
        sql: "INSERT INTO settings(key,value) VALUES('computer_chat_compaction_generation','2') ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(settings.value AS INTEGER)+1 AS TEXT)",
        params: []
      })
      await db.batchTxn(ops)
      const checkpoint = await db.get<{ busy: number }>('PRAGMA wal_checkpoint(TRUNCATE)')
      if (checkpoint?.busy) throw new Error('Hub cleanup checkpoint is busy; retry cleanup')
      if (opts.diagnostics && diagnosticsCutoff !== null)
        await opts.diagnostics.cleanup(owner.taskId, diagnosticsCutoff)
      // A durable GC marker survives I/O failures; the reader's maintenance loop retries.
      await opts.collectReleasedAttachments?.()
    }
  }
  return source
}
