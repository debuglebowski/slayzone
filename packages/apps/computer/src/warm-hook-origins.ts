/**
 * Which agent hooks come from a WARM (pre-booted, not yet adopted) process this
 * computer runs — the one fact only the computer can know, across hub restarts.
 *
 * A warm agent boots with the id of a task that does not exist yet. The hub tracks it
 * in memory only, and forgets it before the agent is gone: it drops its handle and
 * then asks the computer to kill the agent (`pty.warmKill`), whose `SessionEnd` hook
 * fires after that; a hub restart forgets every warm agent at once. A hook the hub can
 * no longer place names a task with no row — so the computer says where it came from
 * (`fromWarm` on the relayed event) and the hub drops it quietly instead of reporting
 * a refused access.
 *
 * Keyed by the PROCESS (`warmId`, stamped into the agent's hook context at spawn),
 * never by task id: a warm agent killed at claim is replaced by a cold one booted with
 * the same task id, and that one's hooks must reach its task.
 *
 * A hook from such an agent can only arrive at the computer process that spawned it
 * (its env names that process's ephemeral loopback port; notify.sh never retries),
 * and whatever this process relays is journaled with the tag before delivery
 * (session-host.ts) — so memory is enough; nothing here needs to outlive the process.
 *
 * Live entries stay until adoption or exit (bounded by the pool: one per project). An
 * ended one is kept {@link WARM_ORIGIN_TTL_MS} for the agent's last hooks, at most
 * {@link WARM_ORIGIN_ENDED_MAX} of them.
 *
 * @module computer/warm-hook-origins
 */

/** Generous for a dying agent's last hooks (notify.sh gives up after 5 s). */
export const WARM_ORIGIN_TTL_MS = 10 * 60_000
export const WARM_ORIGIN_ENDED_MAX = 64

interface Entry {
  /** The task id the agent booted with (its hook context's `taskId`). */
  bootTaskId: string | undefined
  /** When it ended unadopted; absent while it runs. */
  endedAt?: number
}

export class WarmHookOrigins {
  private readonly live = new Map<string, Entry>()
  /** Insertion order = end order, so the first entry is the oldest. */
  private readonly gone = new Map<string, Entry>()

  /** A warm process started (`pty.warmSpawn`). */
  spawned(warmId: string, bootTaskId: string | undefined): void {
    this.gone.delete(warmId)
    this.live.set(warmId, { bootTaskId })
  }

  /** It was adopted by a task (`pty.warmAdopt`): its hooks are that task's now. */
  adopted(warmId: string): void {
    this.live.delete(warmId)
  }

  /** It ended unadopted (killed, exited, or the computer shut down). */
  ended(warmId: string): void {
    const entry = this.live.get(warmId)
    if (!entry) return
    this.live.delete(warmId)
    this.gone.set(warmId, { ...entry, endedAt: Date.now() })
    while (this.gone.size > WARM_ORIGIN_ENDED_MAX) {
      const oldest = this.gone.keys().next().value
      if (oldest === undefined) break
      this.gone.delete(oldest)
    }
  }

  /**
   * The warm process `hook` came from, or null. Both the stamped process id and the
   * task id it booted with must match: an agent can write anything into its own
   * context, so the pair keeps a hook naming some other task from passing as warm.
   */
  originOf(hook: { warmId?: string; taskId?: string }): string | null {
    if (!hook.warmId || !hook.taskId) return null
    this.prune()
    const entry = this.live.get(hook.warmId) ?? this.gone.get(hook.warmId)
    if (!entry?.bootTaskId || entry.bootTaskId !== hook.taskId) return null
    return hook.warmId
  }

  private prune(): void {
    const cutoff = Date.now() - WARM_ORIGIN_TTL_MS
    for (const [warmId, entry] of this.gone) {
      // End order is age order, so the first fresh one ends the sweep.
      if ((entry.endedAt ?? 0) > cutoff) break
      this.gone.delete(warmId)
    }
  }
}
