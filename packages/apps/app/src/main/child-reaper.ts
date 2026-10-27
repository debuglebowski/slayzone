import type { ChildProcess } from 'node:child_process'

/**
 * How the app's supervisors — the local hub (sidecar-server-supervisor.ts) and the
 * local computer (local-computer-supervisor.ts) — kill their child processes.
 *
 * Every kill resolves only once the process is GONE, because an app quit awaits it
 * (lifecycle/quit-reap-child.ts): a kill that resolved early, or a process no kill
 * covered, let the app exit under a live child, which then outlived it — a hub
 * holding the port and database the next app's hub needs, a computer holding every
 * agent pty and the computer id the next app's computer needs.
 */
export type ChildReaper = {
  /** Track a freshly spawned process until it exits (or turns out never to have started). */
  track: (proc: ChildProcess) => void
  /**
   * SIGTERM, escalating to SIGKILL after `sigtermGraceMs`. Resolves when gone.
   * Memoized per process: a second caller (a restart and a stop, two stops) joins
   * the kill already under way — its grace stands — rather than resolving early,
   * restarting the grace or escalating twice.
   */
  kill: (proc: ChildProcess, sigtermGraceMs: number) => Promise<void>
  /**
   * Kill every tracked process not yet exited — the current child, plus one a
   * restart detached and is still killing: exactly the process an un-awaited kill
   * would orphan.
   */
  killAll: (sigtermGraceMs: number) => Promise<void>
}

export function createChildReaper(): ChildReaper {
  const live = new Set<ChildProcess>()
  const kills = new WeakMap<ChildProcess, Promise<void>>()

  const kill = (proc: ChildProcess, sigtermGraceMs: number): Promise<void> => {
    const pending = kills.get(proc)
    if (pending) return pending
    const killing = new Promise<void>((resolve) => {
      // Already dead (its `exit` fired but the handler hasn't run yet), or never
      // started (spawn failed: no pid, `error` instead of `exit`) — no `exit`
      // event is coming, so waiting for one would hang forever.
      if (proc.exitCode !== null || proc.signalCode !== null || proc.pid === undefined) {
        return resolve()
      }
      const killTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }, sigtermGraceMs)
      proc.once('exit', () => {
        clearTimeout(killTimer)
        resolve()
      })
      proc.kill('SIGTERM')
    })
    kills.set(proc, killing)
    return killing
  }

  return {
    track: (proc) => {
      live.add(proc)
      proc.once('exit', () => live.delete(proc))
      // A failed spawn never emits `exit`. (A failed kill also lands here; that
      // process still exits later, and the `exit` listener above drops it then.)
      proc.on('error', () => {
        if (proc.pid === undefined) live.delete(proc)
      })
    },
    kill,
    killAll: (sigtermGraceMs) =>
      Promise.all([...live].map((proc) => kill(proc, sigtermGraceMs))).then(() => undefined)
  }
}
