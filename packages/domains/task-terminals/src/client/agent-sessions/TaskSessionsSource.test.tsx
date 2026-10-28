// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
  registerTaskSessionsSource,
  resetTaskSessionsSourceForTests,
  useTaskSessions,
  type TaskSessionRow,
  type TaskSessionsSource
} from './TaskSessionsSource'

const row: TaskSessionRow = {
  conversationId: 'c1',
  origin: 'slay-spawned-fresh',
  startedAt: 1,
  lastActiveAt: 2,
  messageCount: 3,
  firstPrompt: 'hi',
  isCurrent: true
}

afterEach(() => resetTaskSessionsSourceForTests())

describe('TaskSessionsSource', () => {
  it('useTaskSessions throws until the app registers a source', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderHook(() => useTaskSessions('t1', 'claude-code', true))).toThrow(
      /registerTaskSessionsSource/
    )
  })

  it('delegates to the registered hook with the same arguments', () => {
    const hook = vi.fn<TaskSessionsSource['useTaskSessions']>(() => [row])
    registerTaskSessionsSource({ useTaskSessions: hook })
    const { result } = renderHook(() => useTaskSessions('t1', 'claude-code', false))
    expect(result.current).toEqual([row])
    expect(hook).toHaveBeenCalledWith('t1', 'claude-code', false)
  })

  it('re-registering the same source is a no-op; a different one throws', () => {
    const source: TaskSessionsSource = { useTaskSessions: () => [] }
    registerTaskSessionsSource(source)
    expect(() => registerTaskSessionsSource(source)).not.toThrow()
    expect(() => registerTaskSessionsSource({ useTaskSessions: () => [] })).toThrow(
      /already registered/
    )
  })
})
