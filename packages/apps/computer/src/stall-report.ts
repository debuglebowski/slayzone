/**
 * Reporting this computer's own main-thread stalls.
 *
 * A frozen computer looks dead to its hubs: heartbeats go unanswered and the hub
 * drops the connection. On 2026-11-14 such stalls (whole-history chat reads) dropped
 * the computer again and again, and were only inferable from gaps in its request
 * log. The sampler (`@slayzone/platform/event-loop-stall`, the hub's own) now names
 * each freeze; this module writes it to computer.log and reports it to every hub
 * this computer serves as a `computer.event_loop_stall` diagnostic.
 *
 * A stall is often what dropped the connection, so the report cannot be
 * fire-and-forget: a hub that is away gets it when it is back (bounded outbox).
 * Process commands are reduced to executable names — a shell's `-c` carries an
 * agent's command line, prompt included, and diagnostics hold no chat content.
 *
 * Each hub sees only what is its own: the child processes of ITS work (ptys,
 * processes, chat agents). Machine-wide CPU, and children no hub's work owns (a
 * blocking `git` this computer spawned itself), go to the primary hub only — the
 * desktop's own hub, or the one a standalone computer was set up for. A hub this
 * computer merely joined learns nothing about other hubs' agents or the machine.
 * The measurements and stacks (this process's own code) go to every hub.
 *
 * @module computer/stall-report
 */
import type { EventLoopStall } from '@slayzone/platform/event-loop-stall'
import {
  COMPUTER_EVENT_LOOP_STALL_EVENT_NAME,
  ComputerNotificationMethods,
  type ComputerEventLoopStallPayload
} from '@slayzone/computer-transport/shared'

/** Reports kept per hub while it is away; older ones are dropped (and counted). */
export const STALL_OUTBOX_MAX = 20

/** The executable a command line runs: its first word's basename, no arguments. */
function executableName(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? ''
  return (first.split('/').pop() || '?').slice(0, 64)
}

/** The stall as a hub may hold it: measurements and stacks kept, commands reduced. */
export function sanitizeStallForHub(stall: EventLoopStall): ComputerEventLoopStallPayload {
  return {
    startedAt: stall.startedAt,
    durationMs: stall.durationMs,
    mainThreadCpuMs: stall.mainThreadCpuMs,
    processCpuMs: stall.processCpuMs,
    gcMs: stall.gcMs,
    machineCpuBusyPct: stall.machineCpuBusyPct,
    stacks: stall.stacks.map((s) => ({ atMs: s.atMs, frames: [...s.frames] })),
    children: stall.children.map((c) => ({
      atMs: c.atMs,
      processes: c.processes.map((p) => ({
        pid: p.pid,
        elapsed: p.elapsed,
        command: executableName(p.command)
      }))
    })),
    ...(stall.topCpu
      ? {
          topCpu: stall.topCpu.map((t) => ({
            atMs: t.atMs,
            processes: t.processes.map((p) => ({
              pid: p.pid,
              cpuPct: p.cpuPct,
              command: executableName(p.command)
            }))
          }))
        }
      : {})
  }
}

/** The slice of a hub dialer the reporter needs. */
export interface StallReportDialer {
  notify(method: string, params?: unknown): boolean
  /** Returns the unsubscribe (the dialer's `TypedEventEmitter`). */
  events: { on(event: 'connected', cb: () => void): () => void }
}

/** What a hub may be shown. */
export interface StallReportScope {
  /** The primary hub (machine-wide CPU, unowned children). */
  primary: boolean
  /** Pids of the processes this hub's work runs, read at report time. */
  ownedPids(): Iterable<number>
}

export interface StallReporter {
  /** Report to this hub from now on; returns the detach. */
  attach(dialer: StallReportDialer, scope: StallReportScope): () => void
  /** Log a stall and report it to every attached hub. */
  report(stall: EventLoopStall): void
}

export function createStallReporter(opts: {
  log: (message: string, meta?: Record<string, unknown>) => void
}): StallReporter {
  interface Outbox {
    scope: StallReportScope
    queued: ComputerEventLoopStallPayload[]
    dropped: number
  }
  const outboxes = new Map<StallReportDialer, Outbox>()

  const send = (dialer: StallReportDialer, payload: ComputerEventLoopStallPayload): boolean =>
    dialer.notify(ComputerNotificationMethods.event, {
      name: COMPUTER_EVENT_LOOP_STALL_EVENT_NAME,
      payload
    })

  const flush = (dialer: StallReportDialer, box: Outbox): void => {
    while (box.queued.length > 0) {
      const next = box.queued[0]!
      const payload = box.dropped > 0 ? { ...next, dropped: box.dropped } : next
      if (!send(dialer, payload)) return
      box.queued.shift()
      box.dropped = 0
    }
  }

  return {
    attach(dialer, scope) {
      const box: Outbox = { scope, queued: [], dropped: 0 }
      outboxes.set(dialer, box)
      const unsubscribe = dialer.events.on('connected', () => flush(dialer, box))
      return () => {
        // A test double may not hand back an unsubscribe.
        if (typeof unsubscribe === 'function') unsubscribe()
        outboxes.delete(dialer)
      }
    },
    report(stall) {
      const payload = sanitizeStallForHub(stall)
      opts.log(`event loop stall: main thread froze for ${String(stall.durationMs)}ms`, {
        ...payload
      })
      const owned = new Map<StallReportDialer, Set<number>>()
      for (const [dialer, box] of outboxes) owned.set(dialer, new Set(box.scope.ownedPids()))
      const ownedByAny = new Set([...owned.values()].flatMap((pids) => [...pids]))
      for (const [dialer, box] of outboxes) {
        const mine = owned.get(dialer)!
        const visible = (pid: number): boolean =>
          mine.has(pid) || (box.scope.primary && !ownedByAny.has(pid))
        const { topCpu, ...shared } = payload
        box.queued.push({
          ...shared,
          children: payload.children.map((c) => ({
            atMs: c.atMs,
            processes: c.processes.filter((p) => visible(p.pid))
          })),
          ...(box.scope.primary && topCpu ? { topCpu } : {})
        })
        while (box.queued.length > STALL_OUTBOX_MAX) {
          box.queued.shift()
          box.dropped++
        }
        flush(dialer, box)
      }
    }
  }
}
