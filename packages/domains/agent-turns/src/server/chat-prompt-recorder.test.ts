/**
 * Chat sends land in `agent_prompts` (chat CLIs get no UserPromptSubmit hook),
 * so prompt history covers chat + TUI for a task and survives a chat reset.
 */
import Database from 'better-sqlite3'
import { DB_PRAGMAS } from '@slayzone/platform'
import { runMigrations } from '../../../../shared/db-migrations/src/migrations.js'
import { beforeEach, describe, expect, test } from 'vitest'
import { createSlayzoneDbAdapter } from '../../../../shared/test-utils/ipc-harness.js'
import { createChatPromptRecorder } from './chat-prompt-recorder.js'
import { listPromptsForTask } from './prompt-db.js'
import { agentPromptsEvents } from './events.js'

const raw = new Database(':memory:')
for (const pragma of DB_PRAGMAS) raw.pragma(pragma)
runMigrations(raw)
const db = createSlayzoneDbAdapter(raw)
const taskId = crypto.randomUUID()
raw.prepare(`INSERT INTO projects (id, name, color) VALUES ('p', 'P', '#000')`).run()
raw.prepare(`INSERT INTO tasks (id, project_id, title) VALUES (?, 'p', 'T')`).run(taskId)

const record = createChatPromptRecorder(db)
const ctx = { taskId, mode: 'claude-chat', conversationId: 'conv-1' }

beforeEach(() => {
  raw.prepare('DELETE FROM agent_prompts').run()
})

describe('createChatPromptRecorder', () => {
  test('records a user message as a prompt of the chat mode + conversation', async () => {
    await record('tab-1', { kind: 'user-message', text: 'fix the bug' }, ctx)
    const rows = await listPromptsForTask(db, taskId, 'claude-chat')
    expect(rows.map((r) => [r.text, r.agent_id, r.cli_session_id])).toEqual([
      ['fix the bug', 'claude-chat', 'conv-1']
    ])
  })

  test('notifies prompt-list subscribers for the task', async () => {
    const seen: string[] = []
    const on = (id: string): void => {
      seen.push(id)
    }
    agentPromptsEvents.on('agent-prompts:changed', on)
    try {
      await record('tab-1', { kind: 'user-message', text: 'hello' }, ctx)
    } finally {
      agentPromptsEvents.off('agent-prompts:changed', on)
    }
    expect(seen).toEqual([taskId])
  })

  test('ignores other events, unknown sessions, blank and synthetic texts', async () => {
    await record('tab-1', { kind: 'assistant-text', messageId: 'm', text: 'reply' }, ctx)
    await record('tab-1', { kind: 'user-message', text: 'no session' }, null)
    await record('tab-1', { kind: 'user-message', text: '   ' }, ctx)
    await record('tab-1', { kind: 'user-message', text: '__slay_plan_approved__' }, ctx)
    expect(await listPromptsForTask(db, taskId)).toHaveLength(0)
  })

  test('imported history of a resumed conversation is not recorded again', async () => {
    await record(
      'tab-3',
      { kind: 'user-message', text: 'from the TUI', id: 'h1', history: true },
      ctx
    )
    expect(await listPromptsForTask(db, taskId)).toHaveLength(0)
  })

  test('modes without prompt history (Codex chat) are not recorded', async () => {
    await record('tab-2', { kind: 'user-message', text: 'hi' }, { ...ctx, mode: 'codex-chat' })
    expect(await listPromptsForTask(db, taskId)).toHaveLength(0)
  })
})

describe('listPromptsForTask without an agent', () => {
  test('returns every agent’s prompts of the task, oldest first, tombstones still applied', async () => {
    const insert = (id: string, agent: string, conv: string, text: string, at: number): void => {
      raw
        .prepare(
          `INSERT INTO agent_prompts (id, task_id, agent_id, cli_session_id, text, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(id, taskId, agent, conv, text, at)
    }
    insert('a', 'claude-code', 'tui-1', 'typed in the TUI', 1000)
    insert('b', 'claude-chat', 'chat-1', 'typed in chat', 2000)
    insert('c', 'claude-chat', 'chat-gone', 'deleted session', 3000)
    raw
      .prepare(
        `INSERT INTO session_deletions (id, task_id, mode, conversation_id, created_at)
         VALUES ('d', ?, 'claude-chat', 'chat-gone', 0)`
      )
      .run(taskId)
    const rows = await listPromptsForTask(db, taskId)
    expect(rows.map((r) => r.text)).toEqual(['typed in the TUI', 'typed in chat'])
  })
})
