import { randomUUID } from 'node:crypto'
import {
  agentHookPrompt,
  isPromptCaptureMode,
  chatModeForTerminal,
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
        const history = list(taskId, hook.mode)
        for (const p of history.slice(0, Math.max(0, history.length - 500))) {
          const record = store.findRecords('prompt', taskId).find((r) => r.id === p.id)!,
            owner = store.conversation(record.conversationId)!
          store.removeRecord(record.conversationId, owner.identity.epoch, 'prompt', p.id)
        }
      })
    }
  }
}
