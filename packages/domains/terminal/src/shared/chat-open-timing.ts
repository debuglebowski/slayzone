/**
 * How long opening a chat takes, step by step, on the desktop and mobile clients:
 * one private diagnostic per open (`renderer.chat.open_timing`). Numbers and
 * flags only — `chat-privacy.ts` keeps finite numbers and booleans of a chat
 * diagnostic and drops everything else, so a step's name is its key.
 *
 * Steps are named by what finished, in ms since the open began (`hydrateMs`,
 * `openMs`, `appliedMs`, `paintedMs`); a step timed on its own ends in `…Ms` too
 * (`restoreMs`). Sizes are counts (`stateChars`, `tailEvents`, `replayEvents`).
 */

export const CHAT_OPEN_TIMING_EVENT = 'renderer.chat.open_timing'

export interface ChatOpenTimer {
  /** ms since the timer started, under `name`. The first mark of a name wins. */
  mark(name: string): void
  /** A count or a flag. Non-finite numbers are dropped. */
  set(name: string, value: number | boolean): void
  /** Run `work`, recording how long it took under `name`. */
  time<T>(name: string, work: () => T): T
  payload(): Record<string, number | boolean>
}

const defaultNow = (): number => performance.now()

export function createChatOpenTimer(now: () => number = defaultNow): ChatOpenTimer {
  const start = now()
  const values: Record<string, number | boolean> = {}
  const set = (name: string, value: number | boolean): void => {
    if (typeof value === 'number' && !Number.isFinite(value)) return
    values[name] = value
  }
  return {
    mark(name) {
      if (!(name in values)) set(name, Math.round(now() - start))
    },
    set,
    time(name, work) {
      const t = now()
      try {
        return work()
      } finally {
        set(name, Math.round(now() - t))
      }
    },
    payload: () => ({ ...values })
  }
}

/** The part of a tRPC client this needs (desktop and mobile alike). */
export interface ChatOpenTimingClient {
  diagnostics: {
    recordClientEvent: {
      mutate(input: {
        event: string
        level: 'info'
        message: string
        taskId: string
        payload: Record<string, unknown>
      }): Promise<unknown>
    }
  }
}

/** Record the open's timing. Never throws, never waits: diagnostics never escalate. */
export function reportChatOpenTiming(
  client: ChatOpenTimingClient,
  target: { taskId: string; tabId: string; mode: string; client: 'desktop' | 'mobile' },
  timer: ChatOpenTimer
): void {
  try {
    void client.diagnostics.recordClientEvent
      .mutate({
        event: CHAT_OPEN_TIMING_EVENT,
        level: 'info',
        message: 'chat open timing',
        taskId: target.taskId,
        payload: {
          tabId: target.tabId,
          mode: target.mode,
          mobile: target.client === 'mobile',
          ...timer.payload()
        }
      })
      .catch(() => undefined)
  } catch {
    /* diagnostics never escalate */
  }
}

/** `cb` after the next painted frame (two animation frames; a timer where there are none). */
export function afterNextPaint(cb: () => void): () => void {
  if (typeof requestAnimationFrame !== 'function') {
    const timer = setTimeout(cb, 16)
    return () => clearTimeout(timer)
  }
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(cb)
  })
  return () => cancelAnimationFrame(frame)
}
