/**
 * How a chat shows one background notification that opened an agent-started
 * turn (a `turn-trigger` row).
 *
 * A Monitor ("watch") is a background command the agent started; each line it
 * prints reaches the agent as a hidden message, and the agent answers it with a
 * turn. So the chat shows that message as a small labelled card above the
 * answer: which watch (the agent's own description) and the line it printed.
 *
 * Claude Code also uses the `Monitor event` slot for the watch's lifecycle:
 * when a watch hits its time limit, `<event>` is not output but an instruction
 * for the model (`[Monitor expired after 30m with 1 event delivered. Re-arm it
 * if you still need the watch.]`). That becomes a short "Watch stopped" pill,
 * never the instruction text. Wording the parser does not know falls back to
 * the CLI's summary as-is.
 *
 * @module chat/turn-trigger-notification
 */
import type { TimelineItem } from '@slayzone/terminal/client'

export type TurnTriggerNotification = NonNullable<
  Extract<TimelineItem, { kind: 'turn-trigger' }>['notifications']
>[number]

export interface TurnTriggerCardRow {
  label: string
  value: string
  /** Program output (monospace), not prose. */
  mono?: boolean
}

export type TurnTriggerNotificationView =
  /** Labelled card: `Watch <name>` / `Printed <line>`. */
  | { kind: 'card'; rows: TurnTriggerCardRow[] }
  /** The watch ended at its time limit: a short pill, which watch on hover. */
  | { kind: 'stopped'; text: string; tooltip: { title: string; body: string } }

const MONITOR_EVENT = /^Monitor event: "([\s\S]*)"$/
/** A CLI notice in the `<event>` slot: `[Monitor …]`, whole line. */
const MONITOR_NOTICE = /^\[(Monitor\b[\s\S]*)\]$/
const EXPIRED = /^Monitor expired after (\S+) with (no|\d+) events? delivered\b/
const TIMED_OUT = /^Monitor timed out\b/

const RESTART = 'The agent can restart it.'

function updates(count: string): string {
  if (count === 'no') return 'with no updates'
  return `after ${count} ${count === '1' ? 'update' : 'updates'}`
}

export function describeTurnTriggerNotification(
  notification: TurnTriggerNotification
): TurnTriggerNotificationView {
  const { summary, event } = notification
  const name = MONITOR_EVENT.exec(summary)?.[1]
  if (name === undefined) {
    return {
      kind: 'card',
      rows: [
        { label: 'Task', value: summary },
        ...(event ? [{ label: 'Printed', value: event, mono: true }] : [])
      ]
    }
  }
  const watch: TurnTriggerCardRow = { label: 'Watch', value: name }
  if (!event) return { kind: 'card', rows: [watch] }
  const notice = MONITOR_NOTICE.exec(event.trim())?.[1]
  if (!notice) {
    return { kind: 'card', rows: [watch, { label: 'Printed', value: event, mono: true }] }
  }
  const expired = EXPIRED.exec(notice)
  if (expired || TIMED_OUT.test(notice)) {
    const limit = expired?.[1]
    return {
      kind: 'stopped',
      text: limit ? `Watch stopped · ${limit} limit` : 'Watch stopped',
      tooltip: {
        title: `Watch "${name}"`,
        body: expired
          ? `Reached its ${limit} time limit and stopped ${updates(expired[2])}. ${RESTART}`
          : `Reached its time limit and stopped. ${RESTART}`
      }
    }
  }
  return { kind: 'card', rows: [watch, { label: 'Notice', value: notice }] }
}
