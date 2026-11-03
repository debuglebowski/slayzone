import { describe, expect, it } from 'vitest'
import {
  describeTurnTriggerNotification,
  type TurnTriggerNotification
} from './turn-trigger-notification'

const monitor = (event?: string, name = 'tests'): TurnTriggerNotification => ({
  uuid: 'n',
  taskId: 't',
  summary: `Monitor event: "${name}"`,
  ...(event !== undefined ? { event } : {})
})

// Wording captured from Claude Code 2.1.x session files.
const EXPIRED_ONE =
  '[Monitor expired after 30m with 1 event delivered. Re-arm it if you still need the watch.]'
const EXPIRED_MANY =
  '[Monitor expired after 30m with 4 events delivered. Re-arm it if you still need the watch.]'
const EXPIRED_NONE =
  '[Monitor expired after 45s with no events delivered. Re-arm it if you still need the watch — and widen the filter if silence was unexpected.]'
const TIMED_OUT = '[Monitor timed out — re-arm if needed.]'

describe('describeTurnTriggerNotification', () => {
  it('a line the Monitor printed: a card naming the watch and the line', () => {
    expect(describeTurnTriggerNotification(monitor('status=done | files=6'))).toEqual({
      kind: 'card',
      rows: [
        { label: 'Watch', value: 'tests' },
        { label: 'Printed', value: 'status=done | files=6', mono: true }
      ]
    })
  })

  it('a Monitor event with no line: the watch alone', () => {
    expect(describeTurnTriggerNotification(monitor())).toEqual({
      kind: 'card',
      rows: [{ label: 'Watch', value: 'tests' }]
    })
  })

  it("the Monitor's expiry (the CLI sends it as an event): a 'stopped' pill, never its instruction text", () => {
    expect(describeTurnTriggerNotification(monitor(EXPIRED_ONE))).toEqual({
      kind: 'stopped',
      text: 'Watch stopped · 30m limit',
      tooltip: {
        title: 'Watch "tests"',
        body: 'Reached its 30m time limit and stopped after 1 update. The agent can restart it.'
      }
    })
  })

  it('expiry: plural and zero update counts', () => {
    const many = describeTurnTriggerNotification(monitor(EXPIRED_MANY))
    expect(many.kind === 'stopped' && many.tooltip.body).toBe(
      'Reached its 30m time limit and stopped after 4 updates. The agent can restart it.'
    )
    const none = describeTurnTriggerNotification(monitor(EXPIRED_NONE))
    expect(none.kind === 'stopped' && none.text).toBe('Watch stopped · 45s limit')
    expect(none.kind === 'stopped' && none.tooltip.body).toBe(
      'Reached its 45s time limit and stopped with no updates. The agent can restart it.'
    )
  })

  it('a timeout without a length', () => {
    expect(describeTurnTriggerNotification(monitor(TIMED_OUT))).toEqual({
      kind: 'stopped',
      text: 'Watch stopped',
      tooltip: {
        title: 'Watch "tests"',
        body: 'Reached its time limit and stopped. The agent can restart it.'
      }
    })
  })

  it('an unknown bracketed Monitor notice: a card, the notice as plain text', () => {
    expect(describeTurnTriggerNotification(monitor('[Monitor paused for maintenance.]'))).toEqual({
      kind: 'card',
      rows: [
        { label: 'Watch', value: 'tests' },
        { label: 'Notice', value: 'Monitor paused for maintenance.' }
      ]
    })
  })

  it('a bracketed line the script itself printed is output, not a notice', () => {
    const view = describeTurnTriggerNotification(monitor('[2026-11-03] run 4: GREEN'))
    expect(view.kind === 'card' && view.rows[1]).toEqual({
      label: 'Printed',
      value: '[2026-11-03] run 4: GREEN',
      mono: true
    })
  })

  it('a Monitor name containing quotes still parses', () => {
    const view = describeTurnTriggerNotification(monitor('x', 'grep "ERR"'))
    expect(view.kind === 'card' && view.rows[0].value).toBe('grep "ERR"')
  })

  it('other notifications (a command, a sub-agent): the summary as-is', () => {
    expect(
      describeTurnTriggerNotification({
        uuid: 'n',
        taskId: 't',
        status: 'completed',
        summary: 'Background command "build" completed (exit code 0)'
      })
    ).toEqual({
      kind: 'card',
      rows: [{ label: 'Task', value: 'Background command "build" completed (exit code 0)' }]
    })
  })
})
