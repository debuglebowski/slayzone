import { describe, expect, test } from 'vitest'
import type { Task } from '@slayzone/task-contracts'
import type { TerminalState } from '@slayzone/terminal-contracts'
import { agentBucket, groupByAgent, groupByRecent, needsYouTasks } from './lensLists'

const task = (id: string, extra: Partial<Task> = {}): Task =>
  ({
    id,
    status: 'todo',
    priority: 3,
    needs_attention: false,
    archived_at: null,
    last_interaction_at: null,
    created_at: '2026-01-01T00:00:00Z',
    ...extra
  }) as Task

describe('agent buckets', () => {
  test('unread or errored needs you; running/starting/background run; idle waits', () => {
    expect(agentBucket(task('a', { needs_attention: true }), 'idle')).toBe('needs-you')
    expect(agentBucket(task('a'), 'error')).toBe('needs-you')
    for (const s of ['running', 'starting', 'background'] as TerminalState[])
      expect(agentBucket(task('a'), s)).toBe('running')
    expect(agentBucket(task('a'), 'idle')).toBe('idle')
    for (const s of [undefined, 'dead', 'hibernated'] as Array<TerminalState | undefined>)
      expect(agentBucket(task('a'), s)).toBe('none')
  })

  test('groups come in bucket order, empty ones left out', () => {
    const states: Record<string, TerminalState> = { r: 'running', i: 'idle' }
    const groups = groupByAgent(
      [task('i'), task('n'), task('r'), task('u', { needs_attention: true })],
      (id) => states[id]
    )
    expect(groups.map((g) => [g.key, g.tasks.map((t) => t.id)])).toEqual([
      ['needs-you', ['u']],
      ['running', ['r']],
      ['idle', ['i']],
      ['none', ['n']]
    ])
  })
})

describe('recent', () => {
  test('newest interaction first, bucketed by local day, untouched last', () => {
    const now = new Date(2026, 10, 26, 15, 0)
    const at = (d: number, h: number) => new Date(2026, 10, d, h).getTime()
    const groups = groupByRecent(
      [
        task('old', { last_interaction_at: at(1, 9) }),
        task('never'),
        task('yday', { last_interaction_at: at(25, 9) }),
        task('today2', { last_interaction_at: at(26, 14) }),
        task('today1', { last_interaction_at: at(26, 9) }),
        task('week', { last_interaction_at: at(22, 9) })
      ],
      now
    )
    expect(groups.map((g) => [g.label, g.tasks.map((t) => t.id)])).toEqual([
      ['Today', ['today2', 'today1']],
      ['Yesterday', ['yday']],
      ['This week', ['week']],
      ['Earlier', ['old']],
      ['No activity yet', ['never']]
    ])
  })
})

describe('needs you', () => {
  test('unread first, then idle; archived and done left out', () => {
    const states: Record<string, TerminalState> = { idle: 'idle', run: 'running', gone: 'idle' }
    const list = needsYouTasks(
      [
        task('idle'),
        task('run'),
        task('unread', { needs_attention: true }),
        task('gone', { archived_at: '2026-01-01' }),
        task('done', { needs_attention: true })
      ],
      (id) => states[id],
      new Set(['done'])
    )
    expect(list.map((t) => t.id)).toEqual(['unread', 'idle'])
  })
})
