import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '@slayzone/task-contracts'
import type { Project } from '@slayzone/projects-contracts'
import { CHAT_SUPPORTED_MODES } from '@slayzone/terminal-contracts'
import {
  __resetTerminalFirstForTest,
  clearTerminalFirst,
  getTerminalFirst,
  isTerminalFirstHolding,
  markTerminalFirst,
  markTerminalFirstReady,
  subscribeTerminalFirst,
  TERMINAL_FIRST_HOLD_MAX_MS
} from './terminal-first'

const task = (extra: Partial<Task> = {}): Task =>
  ({ id: 't1', worktree_path: null, base_dir: null, repo_name: null, ...extra }) as unknown as Task
const project = {
  id: 'p',
  placements: [{ computer_id: 'c1', path: '/p', status: 'ready' }],
  resolved_computer_id: 'c1',
  selected_repo: null
} as unknown as Project

afterEach(() => {
  __resetTerminalFirstForTest()
  vi.useRealTimers()
})

describe('terminal-first registry', () => {
  it.each(CHAT_SUPPORTED_MODES)('leaves %s to the chat pane without spawning a shell', (mode) => {
    const seen = vi.fn()
    subscribeTerminalFirst(seen)
    expect(markTerminalFirst(task({ terminal_mode: mode }), project)).toBe(false)
    expect(getTerminalFirst('t1')).toBeNull()
    expect(isTerminalFirstHolding('t1')).toBe(false)
    expect(seen).not.toHaveBeenCalled()
  })

  it.each(['terminal', 'codex', 'claude-code'])('still opens %s terminal-first', (mode) => {
    expect(markTerminalFirst(task({ terminal_mode: mode }), project)).toBe(true)
    expect(isTerminalFirstHolding('t1')).toBe(true)
  })

  it('accepts only a task whose terminal cwd needs nothing async', () => {
    expect(markTerminalFirst(task({ worktree_path: '/w' }), project)).toBe(false)
    expect(getTerminalFirst('t1')).toBeNull()
    expect(markTerminalFirst(task(), project)).toBe(true)
    expect(getTerminalFirst('t1')?.cwd).toBe('/p')
  })

  it('holds the task page until the terminal is ready, then releases it', () => {
    const seen = vi.fn()
    subscribeTerminalFirst(seen)
    markTerminalFirst(task(), project)
    expect(isTerminalFirstHolding('t1')).toBe(true)
    markTerminalFirstReady('t1')
    expect(isTerminalFirstHolding('t1')).toBe(false)
    expect(getTerminalFirst('t1')).not.toBeNull()
    expect(seen).toHaveBeenCalledTimes(2)
  })

  it('never holds the page longer than the cap (agent slow or failing)', () => {
    vi.useFakeTimers()
    markTerminalFirst(task(), project)
    vi.advanceTimersByTime(TERMINAL_FIRST_HOLD_MAX_MS)
    expect(isTerminalFirstHolding('t1')).toBe(false)
  })

  it('an unmarked or cleared task is never held', () => {
    expect(isTerminalFirstHolding('nope')).toBe(false)
    markTerminalFirst(task(), project)
    clearTerminalFirst('t1')
    expect(isTerminalFirstHolding('t1')).toBe(false)
  })
})
