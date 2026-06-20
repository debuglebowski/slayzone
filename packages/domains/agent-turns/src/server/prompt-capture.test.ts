/**
 * agent-prompts capture + db unit tests.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *   --loader ./packages/shared/test-utils/loader.ts \
 *   packages/domains/agent-turns/src/server/prompt-capture.test.ts
 *
 * Self-contains the DB (transport `runMigrations` against an in-memory handle)
 * because the shared `createTestHarness` currently points at a stale migrations
 * path — only the adapter + assertion helpers are reused from it.
 */
import Database from 'better-sqlite3'
import { DB_PRAGMAS } from '@slayzone/platform'
import { runMigrations } from '../../../../shared/transport/src/db-bootstrap/migrations.js'
import {
  createSlayzoneDbAdapter,
  test,
  expect,
  describe
} from '../../../../shared/test-utils/ipc-harness.js'
import { isPromptCaptureMode } from '@slayzone/terminal/shared'
import {
  capturePrompt,
  extractUserPromptText,
  isUserPromptSubmitEvent
} from './prompt-capture.js'
import { listPromptsForTask } from './prompt-db.js'

await describe('extractUserPromptText', () => {
  test('reads raw.prompt (Claude/Codex)', () => {
    expect(extractUserPromptText({ prompt: 'fix the auth bug' })).toBe('fix the auth bug')
  })
  test('falls back to common fields', () => {
    expect(extractUserPromptText({ message: 'hi there' })).toBe('hi there')
  })
  test('null when no usable text', () => {
    expect(extractUserPromptText({ foo: 1 })).toBeNull()
    expect(extractUserPromptText(null)).toBeNull()
    expect(extractUserPromptText({ prompt: '   ' })).toBeNull()
  })
})

await describe('isUserPromptSubmitEvent', () => {
  test('matches normalized variants', () => {
    expect(isUserPromptSubmitEvent('UserPromptSubmit')).toBe(true)
    expect(isUserPromptSubmitEvent('user_prompt_submit')).toBe(true)
    expect(isUserPromptSubmitEvent('PreToolUse')).toBe(false)
    expect(isUserPromptSubmitEvent('Stop')).toBe(false)
  })
})

await describe('isPromptCaptureMode', () => {
  test('only capture-capable terminal modes', () => {
    expect(isPromptCaptureMode('claude-code')).toBe(true)
    expect(isPromptCaptureMode('codex')).toBe(true)
    expect(isPromptCaptureMode('cursor-agent')).toBe(false)
    expect(isPromptCaptureMode('claude-chat')).toBe(false)
    expect(isPromptCaptureMode('terminal')).toBe(false)
  })
})

// --- DB-backed capture ---
const raw = new Database(':memory:')
for (const pragma of DB_PRAGMAS) raw.pragma(pragma)
runMigrations(raw)
const db = createSlayzoneDbAdapter(raw)

const projectId = crypto.randomUUID()
const taskId = crypto.randomUUID()
raw.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId, 'P', '#000')
raw.prepare('INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?)').run(taskId, projectId, 'T1')

await describe('capturePrompt', () => {
  test('stores UserPromptSubmit prompt for the task+agent', async () => {
    raw.prepare('DELETE FROM agent_prompts').run()
    await capturePrompt(db, {
      agentId: 'claude-code',
      hookEvent: 'UserPromptSubmit',
      taskId,
      sessionId: 'cli-1',
      raw: { prompt: 'hello world' }
    })
    const rows = await listPromptsForTask(db, taskId, 'claude-code')
    expect(rows).toHaveLength(1)
    expect(rows[0].text).toBe('hello world')
    expect(rows[0].agent_id).toBe('claude-code')
    expect(rows[0].cli_session_id).toBe('cli-1')
  })

  test('ignores non-UserPromptSubmit events', async () => {
    raw.prepare('DELETE FROM agent_prompts').run()
    await capturePrompt(db, {
      agentId: 'claude-code',
      hookEvent: 'PreToolUse',
      taskId,
      raw: { prompt: 'tool input' }
    })
    expect(await listPromptsForTask(db, taskId, 'claude-code')).toHaveLength(0)
  })

  test('ignores non-capture agent modes', async () => {
    raw.prepare('DELETE FROM agent_prompts').run()
    await capturePrompt(db, {
      agentId: 'cursor-agent',
      hookEvent: 'UserPromptSubmit',
      taskId,
      raw: { prompt: 'nope' }
    })
    expect(await listPromptsForTask(db, taskId, 'cursor-agent')).toHaveLength(0)
  })

  test('ignores when payload has no text', async () => {
    raw.prepare('DELETE FROM agent_prompts').run()
    await capturePrompt(db, {
      agentId: 'claude-code',
      hookEvent: 'UserPromptSubmit',
      taskId,
      raw: {}
    })
    expect(await listPromptsForTask(db, taskId, 'claude-code')).toHaveLength(0)
  })

  test('lists chronologically (oldest first)', async () => {
    raw.prepare('DELETE FROM agent_prompts').run()
    await capturePrompt(db, {
      agentId: 'codex',
      hookEvent: 'UserPromptSubmit',
      taskId,
      raw: { prompt: 'first' },
      now: 1000
    })
    await capturePrompt(db, {
      agentId: 'codex',
      hookEvent: 'UserPromptSubmit',
      taskId,
      raw: { prompt: 'second' },
      now: 2000
    })
    const rows = await listPromptsForTask(db, taskId, 'codex')
    expect(rows.map((r) => r.text).join(',')).toBe('first,second')
  })

  test('scopes by agent mode (main-agent filter)', async () => {
    raw.prepare('DELETE FROM agent_prompts').run()
    await capturePrompt(db, {
      agentId: 'claude-code',
      hookEvent: 'UserPromptSubmit',
      taskId,
      raw: { prompt: 'for claude' }
    })
    await capturePrompt(db, {
      agentId: 'codex',
      hookEvent: 'UserPromptSubmit',
      taskId,
      raw: { prompt: 'for codex' }
    })
    expect(await listPromptsForTask(db, taskId, 'claude-code')).toHaveLength(1)
    expect((await listPromptsForTask(db, taskId, 'codex'))[0].text).toBe('for codex')
  })
})
