import { beforeEach, describe, expect, it } from 'vitest'
import {
  __resetTaskPaneEventsForTest,
  HELD_EVENT_TTL_MS,
  holdTaskPaneEvent,
  isTaskPaneLive,
  markTaskPaneLive,
  takeTaskPaneEvents
} from './taskPaneEvents'

describe('task pane held events', () => {
  beforeEach(() => __resetTaskPaneEventsForTest())

  it('liveness is ref-counted and the unmark is idempotent', () => {
    const a = markTaskPaneLive('t')
    const b = markTaskPaneLive('t')
    a()
    a()
    expect(isTaskPaneLive('t')).toBe(true)
    b()
    expect(isTaskPaneLive('t')).toBe(false)
  })

  it('takes held events of the asked kinds in arrival order, keeps the rest', () => {
    holdTaskPaneEvent({ kind: 'browser-ensure-panel-open', payload: { taskId: 't' } }, 0)
    holdTaskPaneEvent({ kind: 'respawn-suggested', payload: { taskId: 't' } }, 1)
    holdTaskPaneEvent({ kind: 'browser-create-tab', payload: { taskId: 't', tabId: 'x' } }, 2)
    holdTaskPaneEvent({ kind: 'open-artifact', payload: { taskId: 'u', artifactId: 'a' } }, 3)

    const page = takeTaskPaneEvents('t', ['browser-ensure-panel-open', 'browser-create-tab'], 10)
    expect(page.map((e) => e.kind)).toEqual(['browser-ensure-panel-open', 'browser-create-tab'])
    expect(takeTaskPaneEvents('t', ['browser-create-tab'], 10)).toEqual([])
    expect(takeTaskPaneEvents('t', ['respawn-suggested'], 10).map((e) => e.kind)).toEqual([
      'respawn-suggested'
    ])
    expect(takeTaskPaneEvents('u', ['open-artifact'], 10)).toHaveLength(1)
  })

  it('drops expired events (their tab never mounted)', () => {
    holdTaskPaneEvent({ kind: 'open-artifact', payload: { taskId: 't', artifactId: 'a' } }, 0)
    expect(takeTaskPaneEvents('t', ['open-artifact'], HELD_EVENT_TTL_MS + 1)).toEqual([])
  })
})
