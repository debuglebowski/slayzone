/**
 * ClaudeTaskNotifications: the `<task-notification>` records Claude Code writes
 * to its session file (a Monitor event, a background task's end) → the
 * `background-notification` events naming what opened an agent-started turn.
 * Record shapes: Claude Code 2.1.316 (captured live: a Monitor event, then the
 * Monitor's end).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { encodeClaudeProjectDir } from '../claude-transcripts'
import { ClaudeTaskNotifications, parseTaskNotification } from './claude-task-notifications'

const MONITOR_EVENT =
  '<task-notification>\n<task-id>b3absfw0x</task-id>\n<summary>Monitor event: "cap test"</summary>\n<event>EVENT_ONE</event>\nIf this event is something the user would act on now, send a PushNotification. Routine or benign output doesn\'t need one.\n</task-notification>'
const MONITOR_ENDED =
  '<task-notification>\n<task-id>b3absfw0x</task-id>\n<tool-use-id>toolu_01L2B29NHaCBmh5Wqc5bgKL5</tool-use-id>\n<output-file>/private/tmp/x/tasks/b3absfw0x.output</output-file>\n<status>completed</status>\n<summary>Monitor "cap test" stream ended</summary>\n</task-notification>'

const T0 = Date.parse('2026-11-02T15:39:50.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

const notificationRecord = (uuid: string, content: string, at = T0 + 5_000) => ({
  parentUuid: 'p',
  isSidechain: false,
  type: 'user',
  message: { role: 'user', content },
  origin: { kind: 'task-notification', producer: 'session-task' },
  uuid,
  timestamp: iso(at)
})
const assistantRecord = (uuid: string, at = T0 + 6_000, isSidechain = false) => ({
  parentUuid: 'p',
  isSidechain,
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: 'GOT' }] },
  uuid,
  timestamp: iso(at)
})
const queueRecord = (content: string, at = T0 + 5_000) => ({
  type: 'queue-operation',
  operation: 'enqueue',
  timestamp: iso(at),
  content
})

describe('parseTaskNotification', () => {
  it('a Monitor event: task id, summary, the line it reported', () => {
    expect(parseTaskNotification(notificationRecord('n1', MONITOR_EVENT))).toEqual({
      kind: 'background-notification',
      uuid: 'n1',
      taskId: 'b3absfw0x',
      summary: 'Monitor event: "cap test"',
      event: 'EVENT_ONE'
    })
  })

  it("a task's end: its tool call and status too", () => {
    expect(parseTaskNotification(notificationRecord('n2', MONITOR_ENDED))).toEqual({
      kind: 'background-notification',
      uuid: 'n2',
      taskId: 'b3absfw0x',
      toolUseId: 'toolu_01L2B29NHaCBmh5Wqc5bgKL5',
      status: 'completed',
      summary: 'Monitor "cap test" stream ended'
    })
  })

  it('content as text blocks reads the same', () => {
    const record = {
      ...notificationRecord('n3', ''),
      message: { role: 'user', content: [{ type: 'text', text: MONITOR_EVENT }] }
    }
    expect(parseTaskNotification(record)?.event).toBe('EVENT_ONE')
  })

  it('not a notification: a user message, a queue entry, a sub-agent record, no task id', () => {
    expect(
      parseTaskNotification({ ...notificationRecord('u', 'hello'), origin: undefined })
    ).toBeNull()
    expect(parseTaskNotification(queueRecord(MONITOR_EVENT))).toBeNull()
    expect(
      parseTaskNotification({ ...notificationRecord('s', MONITOR_EVENT), isSidechain: true })
    ).toBeNull()
    expect(
      parseTaskNotification(
        notificationRecord('x', '<task-notification><summary>s</summary></task-notification>')
      )
    ).toBeNull()
  })

  it('an older CLI without `origin`: the content alone tells it', () => {
    const record = { ...notificationRecord('n4', MONITOR_EVENT), origin: undefined }
    expect(parseTaskNotification(record)?.taskId).toBe('b3absfw0x')
  })
})

describe('ClaudeTaskNotifications (reads the session file during a turn)', () => {
  let dir: string
  let file: string
  let emitted: AgentEvent[]
  let tail: ClaudeTaskNotifications
  const write = (...records: object[]) =>
    appendFileSync(file, records.map((r) => JSON.stringify(r) + '\n').join(''))
  const uuids = () => emitted.map((e) => (e.kind === 'background-notification' ? e.uuid : '?'))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-task-notifications-'))
    file = join(dir, 'sid.jsonl')
    emitted = []
    tail = new ClaudeTaskNotifications({
      emit: (ev) => emitted.push(ev),
      startedAt: T0,
      pathOf: () => file,
      intervalMs: 0
    })
  })
  afterEach(() => {
    tail.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it("the record the CLI writes after the turn's init is emitted", async () => {
    writeFileSync(file, '')
    tail.turnStarted('/cwd', 'sid')
    write(queueRecord(MONITOR_EVENT), notificationRecord('n1', MONITOR_EVENT))
    await tail.poll()
    expect(uuids()).toEqual(['n1'])
  })

  it('a notification the agent already answered (an assistant record follows) is not', async () => {
    write(notificationRecord('old', MONITOR_EVENT), assistantRecord('a1'))
    tail.turnStarted('/cwd', 'sid')
    write(notificationRecord('n1', MONITOR_EVENT, T0 + 7_000))
    await tail.poll()
    expect(uuids()).toEqual(['n1'])
  })

  it("a sub-agent's assistant record does not count as an answer", async () => {
    write(notificationRecord('n1', MONITOR_EVENT), assistantRecord('a1', T0 + 6_000, true))
    tail.turnStarted('/cwd', 'sid')
    await tail.poll()
    expect(uuids()).toEqual(['n1'])
  })

  it("a record older than this process (a resumed conversation's past) is not", async () => {
    write(notificationRecord('past', MONITOR_EVENT, T0 - 60_000))
    tail.turnStarted('/cwd', 'sid')
    await tail.poll()
    expect(uuids()).toEqual([])
  })

  it('each record once, across polls and turns', async () => {
    tail.turnStarted('/cwd', 'sid')
    write(notificationRecord('n1', MONITOR_EVENT))
    await tail.poll()
    await tail.poll()
    tail.turnStarted('/cwd', 'sid')
    await tail.poll()
    expect(uuids()).toEqual(['n1'])
  })

  it('a line split across two reads is read whole', async () => {
    tail.turnStarted('/cwd', 'sid')
    const line = JSON.stringify(notificationRecord('n1', MONITOR_EVENT)) + '\n'
    appendFileSync(file, line.slice(0, 40))
    await tail.poll()
    appendFileSync(file, line.slice(40))
    await tail.poll()
    expect(uuids()).toEqual(['n1'])
  })

  it("stops reading at the turn's first output: later records wait for the next turn", async () => {
    tail.turnStarted('/cwd', 'sid')
    tail.turnOutput()
    write(notificationRecord('mid', MONITOR_EVENT))
    await tail.poll()
    expect(uuids()).toEqual([])
  })

  it('no session file yet: nothing, no error', async () => {
    tail.turnStarted('/cwd', 'sid')
    await tail.poll()
    expect(uuids()).toEqual([])
  })

  it('a switched session file starts from its own beginning', async () => {
    const other = join(dir, 'other.jsonl')
    let path = file
    tail.dispose()
    tail = new ClaudeTaskNotifications({
      emit: (ev) => emitted.push(ev),
      startedAt: T0,
      pathOf: () => path,
      intervalMs: 0
    })
    write(notificationRecord('a', MONITOR_EVENT))
    tail.turnStarted('/cwd', 'sid')
    await tail.poll()
    path = other
    writeFileSync(other, JSON.stringify(notificationRecord('b', MONITOR_EVENT)) + '\n')
    tail.turnStarted('/cwd', 'other')
    await tail.poll()
    expect(uuids()).toEqual(['a', 'b'])
  })
})

// A session that used EnterWorktree keeps its file only under the worktree's
// project dir: the default lookup must follow it, not read a file that is gone.
describe('ClaudeTaskNotifications (default path: a session that moved folders)', () => {
  const configDir = realpathSync(mkdtempSync(join(tmpdir(), 'ctn-config-')))
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'ctn-work-')))
  const repo = join(work, 'repo')
  const worktree = join(repo, '.claude', 'worktrees', 'wt1')
  const sid = 'c0ffee00-0000-4000-8000-000000000001'
  let prev: string | undefined
  beforeEach(() => {
    prev = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configDir
    mkdirSync(worktree, { recursive: true })
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prev
  })

  it('finds the file under the worktree project dir and emits its notification', async () => {
    const dir = join(configDir, 'projects', encodeClaudeProjectDir(worktree))
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${sid}.jsonl`)
    writeFileSync(file, `${JSON.stringify({ type: 'relocated', relocatedCwd: worktree })}\n`)
    const emitted: AgentEvent[] = []
    const tail = new ClaudeTaskNotifications({
      emit: (ev) => emitted.push(ev),
      startedAt: T0,
      intervalMs: 0
    })
    tail.turnStarted(repo, sid)
    await tail.poll()
    appendFileSync(file, `${JSON.stringify(notificationRecord('moved-1', MONITOR_EVENT))}\n`)
    await tail.poll()
    tail.dispose()
    expect(emitted.map((e) => (e.kind === 'background-notification' ? e.uuid : '?'))).toEqual([
      'moved-1'
    ])
  })
})
