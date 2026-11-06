/**
 * Turn recording is WIRED: an agent terminal's submitted prompt and a chat turn's
 * `result` each record a turn snapshot, from the sources the hub composition passes.
 *
 * Regression (QA 2026-11-06, task 964073b0 "agent-turn snapshots" → 5decc957):
 * daf8d3bb4 (2026-08-06) removed the only callers of `initPtyTurnSubscriber` and
 * `initChatTurnSubscriber` from Electron main, saying the sidecar ran them; nothing
 * did. Since then no agent turn of any kind recorded a snapshot. The snapshot's git
 * runs on the checkout's (loopback) computer, as in production.
 */
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { installLoopbackTurnComputer } from '../../../../shared/test-utils/loopback-git-computer.js'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { wireTurnRecording, type TurnRecordingSources } from './turn-recording.js'
import { listTurnsForWorktree } from './db.js'

installLoopbackTurnComputer()

function git(repo: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

const repos: string[] = []
const h = await createTestHarness()
const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId, 'P', '#000')

function freshTab(mode: string): { taskId: string; tabId: string; repo: string } {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slayzone-trw-')))
  repos.push(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@test')
  git(repo, 'config', 'user.name', 'test')
  fs.writeFileSync(path.join(repo, 'seed.txt'), 'initial')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'init')
  const taskId = crypto.randomUUID()
  const tabId = `tab-${taskId.slice(0, 8)}`
  h.db
    .prepare('INSERT INTO tasks (id, project_id, title, worktree_path) VALUES (?, ?, ?, ?)')
    .run(taskId, projectId, 'T', repo)
  h.db
    .prepare('INSERT INTO terminal_tabs (id, task_id, mode, position) VALUES (?, ?, ?, ?)')
    .run(tabId, taskId, mode, 0)
  return { taskId, tabId, repo }
}

/** The two sources the hub composition hands over: pty submits and the chat relay. */
function fakeSources() {
  const submits = new Set<(sessionId: string, taskId: string, line: string) => void>()
  const chat = new EventEmitter()
  const sources: TurnRecordingSources = {
    onPtyInputSubmit: (cb) => {
      submits.add(cb)
      return () => submits.delete(cb)
    },
    chatEvents: chat as unknown as TurnRecordingSources['chatEvents']
  }
  return {
    sources,
    submit: (sessionId: string, taskId: string, line: string) => {
      for (const cb of submits) cb(sessionId, taskId, line)
    },
    chat: (tabId: string, event: AgentEvent, seq: number, live?: number) =>
      chat.emit('event', tabId, event, seq, live, Date.now())
  }
}

async function turnsSettle(repo: string, n: number): Promise<number> {
  const deadline = Date.now() + 10_000
  let count = 0
  while (Date.now() < deadline) {
    count = (await listTurnsForWorktree(h.slayDb, repo)).length
    if (count >= n) break
    await new Promise((r) => setTimeout(r, 25))
  }
  return count
}

/** Long enough for a fire-and-forget boundary that SHOULD NOT happen to show up. */
const settle = () => new Promise((r) => setTimeout(r, 400))

describe('wireTurnRecording', () => {
  test('agent terminal: a submitted prompt records a turn', async () => {
    const s = fakeSources()
    const stop = wireTurnRecording(h.slayDb, s.sources)
    const { taskId, tabId, repo } = freshTab('codex')
    fs.writeFileSync(path.join(repo, 'edit.txt'), 'agent edit')
    s.submit(`${taskId}:${tabId}`, taskId, 'fix the bug')
    expect(await turnsSettle(repo, 1)).toBe(1)
    stop()
  })

  test('plain shell tab: no turn', async () => {
    const s = fakeSources()
    const stop = wireTurnRecording(h.slayDb, s.sources)
    const { taskId, tabId, repo } = freshTab('terminal')
    fs.writeFileSync(path.join(repo, 'edit.txt'), 'x')
    s.submit(`${taskId}:${tabId}`, taskId, 'ls')
    await settle()
    expect(await listTurnsForWorktree(h.slayDb, repo)).toHaveLength(0)
    stop()
  })

  test('chat: user-message then result records a turn with the prompt', async () => {
    const s = fakeSources()
    const stop = wireTurnRecording(h.slayDb, s.sources)
    const { tabId, repo } = freshTab('claude-chat')
    s.chat(tabId, { kind: 'user-message', text: 'add a readme' } as AgentEvent, 1)
    fs.writeFileSync(path.join(repo, 'README.md'), '# hi')
    s.chat(tabId, { kind: 'result' } as AgentEvent, 2)
    expect(await turnsSettle(repo, 1)).toBe(1)
    expect((await listTurnsForWorktree(h.slayDb, repo))[0].prompt_preview).toBe('add a readme')
    stop()
  })

  test('chat owned by a computer: the turn records, its prompt stays on the computer', async () => {
    // Migration v187: the hub holds no prompt text for a task whose chat a computer
    // owns (a trigger refuses it). The boundary must still record — with no preview.
    const s = fakeSources()
    const stop = wireTurnRecording(h.slayDb, s.sources)
    const { taskId, tabId, repo } = freshTab('claude-chat')
    h.db
      .prepare(
        'INSERT INTO chat_ownership (id, task_id, tab_id, mode, computer_id, epoch, state) VALUES (?, ?, ?, ?, ?, 1, ?)'
      )
      .run(`conv-${taskId}`, taskId, tabId, 'claude-chat', 'pc', 'active')
    s.chat(tabId, { kind: 'user-message', text: 'secret prompt' } as AgentEvent, 1)
    fs.writeFileSync(path.join(repo, 'owned.txt'), 'x')
    s.chat(tabId, { kind: 'result' } as AgentEvent, 2)
    expect(await turnsSettle(repo, 1)).toBe(1)
    expect((await listTurnsForWorktree(h.slayDb, repo))[0].prompt_preview).toBe('')
    stop()
  })

  test('chat: a live fragment and imported history record nothing', async () => {
    const s = fakeSources()
    const stop = wireTurnRecording(h.slayDb, s.sources)
    const { tabId, repo } = freshTab('codex-chat')
    s.chat(tabId, { kind: 'user-message', text: 'p' } as AgentEvent, 1)
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a')
    // A live fragment repeats the seq of the saved event it follows.
    s.chat(tabId, { kind: 'result' } as AgentEvent, 1, 0)
    s.chat(tabId, { kind: 'result', history: true } as unknown as AgentEvent, 2)
    await settle()
    expect(await listTurnsForWorktree(h.slayDb, repo)).toHaveLength(0)
    s.chat(tabId, { kind: 'result' } as AgentEvent, 3)
    expect(await turnsSettle(repo, 1)).toBe(1)
    stop()
  })

  test('stop() unsubscribes both sources', async () => {
    const s = fakeSources()
    wireTurnRecording(h.slayDb, s.sources)()
    const { taskId, tabId, repo } = freshTab('claude-code')
    fs.writeFileSync(path.join(repo, 'edit.txt'), 'x')
    s.submit(`${taskId}:${tabId}`, taskId, 'go')
    await settle()
    expect(await listTurnsForWorktree(h.slayDb, repo)).toHaveLength(0)
  })
})

afterAll(() => {
  for (const r of repos) fs.rmSync(r, { recursive: true, force: true })
  h.cleanup()
})
