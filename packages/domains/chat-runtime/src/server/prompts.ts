import { randomUUID } from 'node:crypto'
import {
  agentHookPrompt,
  isPromptCaptureMode,
  chatModeForTerminal,
  isSyntheticChatPrompt,
  type ResolvedAgentHook
} from '@slayzone/terminal-contracts'
import type { ChatStorage } from './storage'
interface LocalPrompt {
  id: string
  taskId: string
  agentId: string
  cliSessionId: string | null
  text: string
  createdAt: number
}
/** Same recall limit as the legacy prompt store; the event history remains intact. */
export function trimLocalPromptHistory(store: ChatStorage, taskId: string, agentId: string) {
  store.compose((raw) =>
    raw
      .prepare(`DELETE FROM records WHERE rowid IN (
    SELECT r.rowid FROM records r JOIN conversations c ON c.id=r.conversation_id
    WHERE c.task_id=? AND c.state='active' AND r.kind='prompt' AND json_extract(r.value,'$.agentId')=?
    ORDER BY json_extract(r.value,'$.createdAt') DESC,r.id DESC LIMIT -1 OFFSET 500
  )`)
      .run(taskId, agentId)
  )
}
export function createLocalPrompts(store: ChatStorage) {
  function list(
    taskId: string,
    agentId?: string,
    excluded: Array<{ mode: string; conversationId: string }> = []
  ) {
    return store
      .findRecords('prompt', taskId)
      .filter((r) => store.conversation(r.conversationId)?.state === 'active')
      .map((r) => r.value as LocalPrompt)
      .filter(
        (p) =>
          (!agentId || p.agentId === agentId) &&
          !excluded.some((d) => d.mode === p.agentId && d.conversationId === p.cliSessionId)
      )
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }
  return {
    /** Full-history summaries are independent of the bounded composer recall list. */
    summaries(taskId: string, conversationIds: string[]) {
      const wanted = new Set(conversationIds)
      type Summary = { conversationId: string; count: number; firstPrompt: string; firstAt: number }
      const captured = new Map<string, Summary>(),
        events = new Map<string, Summary>()
      const seenPrompts = new Set<string>(),
        seenEvents = new Set<string>()
      function add(target: Map<string, Summary>, id: string, text: string, at: number) {
        const prior = target.get(id)
        if (!prior) target.set(id, { conversationId: id, count: 1, firstPrompt: text, firstAt: at })
        else {
          prior.count++
          if (at < prior.firstAt) {
            prior.firstAt = at
            prior.firstPrompt = text
          }
        }
      }
      for (const p of list(taskId)) {
        if (!p.cliSessionId || !wanted.has(p.cliSessionId) || seenPrompts.has(p.id)) continue
        seenPrompts.add(p.id)
        add(captured, p.cliSessionId, p.text, p.createdAt)
      }
      store.compose((raw) => {
        const rows = raw
          .prepare(`SELECT e.conversation_id AS storage_id,e.seq,e.saved_at,
          json_extract(e.event,'$.kind') AS kind,json_extract(e.event,'$.sessionId') AS session_id,
          json_extract(e.event,'$.conversationId') AS branch_id,json_extract(e.event,'$.id') AS message_id,
          json_extract(e.event,'$.text') AS text
          FROM events e JOIN conversations c ON c.id=e.conversation_id
          WHERE c.task_id=? AND c.state='active'
            AND json_extract(e.event,'$.kind') IN ('turn-init','conversation-branch','user-message')
          ORDER BY e.conversation_id,e.seq`)
          .iterate(taskId) as Iterable<{
          storage_id: string
          seq: number
          saved_at: number
          kind: string
          session_id: string | null
          branch_id: string | null
          message_id: string | null
          text: string | null
        }>
        let storageId: string | null = null,
          nativeId: string | null = null
        let pending: Array<{ id: string; text: string; at: number }> = []
        function message(id: string, text: string, at: number) {
          if (!nativeId || !wanted.has(nativeId)) return
          const key = JSON.stringify([nativeId, id])
          if (seenEvents.has(key)) return
          seenEvents.add(key)
          add(events, nativeId, text, at)
        }
        for (const row of rows) {
          if (row.storage_id !== storageId) {
            storageId = row.storage_id
            nativeId = null
            pending = []
          }
          if (row.kind === 'turn-init' || row.kind === 'conversation-branch') {
            nativeId = row.kind === 'turn-init' ? row.session_id : row.branch_id
            for (const p of pending) message(p.id, p.text, p.at)
            pending = []
            continue
          }
          const text = row.text?.trim()
          if (!text || isSyntheticChatPrompt(text)) continue
          const id = row.message_id ?? JSON.stringify([storageId, row.seq])
          if (nativeId) message(id, text, row.saved_at)
          else pending.push({ id, text, at: row.saved_at })
        }
      })
      const result: Summary[] = []
      for (const id of wanted) {
        const a = captured.get(id),
          b = events.get(id)
        if (!a && !b) continue
        const first = !a ? b! : !b || a.firstAt <= b.firstAt ? a : b
        result.push({ ...first, count: Math.max(a?.count ?? 0, b?.count ?? 0) })
      }
      return result
    },
    list: (
      taskId: string,
      agentId?: string,
      excluded?: Array<{ mode: string; conversationId: string }>
    ) =>
      list(taskId, agentId, excluded).map((p) => ({
        id: p.id,
        task_id: p.taskId,
        agent_id: p.agentId,
        cli_session_id: p.cliSessionId,
        text: p.text,
        created_at: p.createdAt
      })),
    capture(hook: ResolvedAgentHook) {
      const text = agentHookPrompt(hook),
        taskId = hook.taskId
      if (!taskId || !text || !isPromptCaptureMode(hook.agentId)) return
      if (store.conversation(`task-tombstone:${taskId}`)?.state === 'deleted')
        throw new Error('Task chat history was deleted')
      const mode = chatModeForTerminal(hook.mode) ?? 'claude-chat'
      const existing = store
        .listForTask(taskId)
        .find(
          (r) =>
            r.state === 'active' &&
            r.identity.mode === mode &&
            !store.getRecord(r.identity.id, 'settings', 'inbox')
        )
      const identity = existing?.identity ?? {
        id: `hook-inbox:${taskId}`,
        taskId,
        tabId: `hook-inbox:${taskId}`,
        mode,
        epoch: 1
      }
      store.transaction(() => {
        if (!existing) {
          store.createConversation(identity)
          store.putRecord(identity.id, identity.epoch, {
            kind: 'settings',
            id: 'inbox',
            value: true,
            at: 0
          })
        }
        const prompt: LocalPrompt = {
          id: randomUUID(),
          taskId,
          agentId: hook.mode,
          cliSessionId: hook.sessionId ?? null,
          text,
          createdAt: Date.now()
        }
        store.putRecord(identity.id, identity.epoch, {
          kind: 'prompt',
          id: prompt.id,
          value: prompt,
          at: prompt.createdAt
        })
        trimLocalPromptHistory(store, taskId, hook.mode)
      })
    }
  }
}
