/**
 * taskEvents bus contract tests.
 * Run with: npx tsx --loader ./packages/shared/test-utils/loader.ts packages/domains/task/src/main/events.test.ts
 */
import { test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { taskEvents } from './events.js'
import type { TaskEventMap } from './events.js'

await describe('taskEvents bus', () => {
  test('emit fires registered listener with typed payload', () => {
    const calls: TaskEventMap['task:created'][] = []
    const listener = (p: TaskEventMap['task:created']) => calls.push(p)
    taskEvents.on('task:created', listener)
    taskEvents.emit('task:created', { taskId: 't1', projectId: 'p1' })
    taskEvents.off('task:created', listener)
    expect(calls).toHaveLength(1)
    expect(calls[0].taskId).toBe('t1')
    expect(calls[0].projectId).toBe('p1')
  })

  test('multi-listener: all listeners fire in registration order', () => {
    const order: string[] = []
    const a = () => order.push('a')
    const b = () => order.push('b')
    const c = () => order.push('c')
    taskEvents.on('task:archived', a)
    taskEvents.on('task:archived', b)
    taskEvents.on('task:archived', c)
    taskEvents.emit('task:archived', { taskId: 't', projectId: 'p' })
    taskEvents.off('task:archived', a)
    taskEvents.off('task:archived', b)
    taskEvents.off('task:archived', c)
    expect(order).toEqual(['a', 'b', 'c'])
  })

  test('off removes listener; no further calls', () => {
    let count = 0
    const listener = () => { count++ }
    taskEvents.on('task:updated', listener)
    taskEvents.emit('task:updated', { taskId: 't', projectId: 'p' })
    taskEvents.off('task:updated', listener)
    taskEvents.emit('task:updated', { taskId: 't', projectId: 'p' })
    expect(count).toBe(1)
  })

  test('listener for unrelated event does not trigger', () => {
    let count = 0
    const listener = () => { count++ }
    taskEvents.on('task:created', listener)
    taskEvents.emit('task:archived', { taskId: 't', projectId: 'p' })
    taskEvents.emit('task:deleted', { taskId: 't', projectId: 'p' })
    taskEvents.off('task:created', listener)
    expect(count).toBe(0)
  })

  test('payload pass-through for task:updated.oldStatus', () => {
    let captured: TaskEventMap['task:updated'] | undefined
    const listener = (p: TaskEventMap['task:updated']) => { captured = p }
    taskEvents.on('task:updated', listener)
    taskEvents.emit('task:updated', { taskId: 't', projectId: 'p', oldStatus: 'todo' })
    taskEvents.off('task:updated', listener)
    expect(captured?.oldStatus).toBe('todo')
  })

  test('payload pass-through for task:tag-changed.tagId (nullable)', () => {
    const captured: TaskEventMap['task:tag-changed'][] = []
    const listener = (p: TaskEventMap['task:tag-changed']) => { captured.push(p) }
    taskEvents.on('task:tag-changed', listener)
    taskEvents.emit('task:tag-changed', { taskId: 't', projectId: 'p', tagId: 'tag1' })
    taskEvents.emit('task:tag-changed', { taskId: 't', projectId: 'p', tagId: null })
    taskEvents.emit('task:tag-changed', { taskId: 't', projectId: 'p' })
    taskEvents.off('task:tag-changed', listener)
    expect(captured).toHaveLength(3)
    expect(captured[0].tagId).toBe('tag1')
    expect(captured[1].tagId).toBeNull()
    expect(captured[2].tagId).toBeUndefined()
  })

  test('emit returns true when listener is registered, false when none', () => {
    expect(taskEvents.emit('task:restored', { taskId: 't', projectId: 'p' })).toBe(false)
    const listener = () => {}
    taskEvents.on('task:restored', listener)
    expect(taskEvents.emit('task:restored', { taskId: 't', projectId: 'p' })).toBe(true)
    taskEvents.off('task:restored', listener)
  })

  test('remove non-registered listener is a no-op', () => {
    const listener = () => {}
    // Off without prior on shouldn't throw
    taskEvents.off('task:created', listener)
    expect(true).toBe(true)
  })
})
