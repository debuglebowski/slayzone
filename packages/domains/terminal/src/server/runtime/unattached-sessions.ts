/**
 * Terminal sessions a computer still runs from a previous hub run — adopted, or
 * surfaced. Never silently killed, never silently abandoned.
 *
 * Hub processes restart (the desktop's "Restart local hub", a crashed sidecar, a
 * standalone hub, a desktop restart with a remote computer); computers keep their
 * ptys. The routing backend lists what its computers run that nothing in this hub
 * run tracks (`PtyBackend.untrackedSessions`). Each one is:
 *
 *   1. ADOPTED into its tab when it can be: the tab's launch is resolved from the
 *      hub's records (`UnattachedLaunchResolver`, wired by the composition root),
 *      then `pty.create` runs with the attach intent — nothing is started, the
 *      running process is registered like any session (output, input, state, exit).
 *      A hub restart is then invisible to the agent.
 *   2. Otherwise SURFACED, with the reason: listed here (Settings, `slay pty
 *      unattached`, the tab's "Session not attached" overlay), with the user's two
 *      actions — attach again (`attach`), or stop it (`kill`).
 *
 * The set follows the backend's: a session the computer stops listing (it exited,
 * the computer restarted) leaves the registry.
 */
import { recordDiagnosticEvent } from '@slayzone/diagnostics/server'
import { awaitPtyOperation, type PtyBackend, type UntrackedPtySession } from './pty-backend'
import type { PtyCreateResult } from './pty-manager'

/** Why a session is not adopted (see the module doc). */
export type UnattachedReason =
  /** Not a `<taskId>:<tabId>` session: no tab to adopt it into. */
  | 'unknown-session-id'
  /** No output detection on the computer (or no attempt key): an older computer. */
  | 'no-detection'
  /** The computer cannot take a session over (it predates `pty.adopt`). */
  | 'computer-too-old'
  /** The task runs on another computer now. */
  | 'task-elsewhere'
  /** The tab runs another agent now than the process does. */
  | 'mode-mismatch'
  /** The computer refused (no longer running as that attempt, another start in flight …). */
  | 'not-adoptable'
  /** A session is attached at that id already. */
  | 'already-tracked'
  /** The tab's launch could not be resolved (task or tab gone, a database error …). */
  | 'launch-unresolved'

/** What `pty.create` is called with to adopt a session (the tab's own launch). */
export interface UnattachedLaunch {
  sessionId: string
  cwd: string
  mode: string
  providerFlags?: string | null
  executionContext?: unknown
}

/**
 * Resolve the tab a session belongs to into its launch, from the hub's records —
 * or say why it cannot be adopted. Wired by the composition root (the task domain
 * owns task/tab resolution).
 */
export type UnattachedLaunchResolver = (target: {
  computerId: string
  sessionId: string
  taskId: string
  tabId: string
  /** The mode the process runs as (absent: an older computer). */
  mode?: string
}) => Promise<
  | { ok: true; launch: UnattachedLaunch }
  | {
      ok: false
      reason: Extract<UnattachedReason, 'task-elsewhere' | 'mode-mismatch' | 'launch-unresolved'>
      detail?: string
    }
>

/** One session in the registry. */
export interface UnattachedSession extends UntrackedPtySession {
  /** From a `<taskId>:<tabId>` session id; null otherwise. */
  taskId: string | null
  tabId: string | null
  /** `adopting`: being taken over now. `unattached`: could not be (see `reason`). */
  status: 'adopting' | 'unattached'
  reason?: UnattachedReason
  /** The refusal's own words, when there were any. */
  detail?: string
}

export interface UnattachedSessions {
  /** Follow the backend's untracked set (idempotent). */
  start(): void
  stop(): void
  list(): UnattachedSession[]
  /** Try to adopt it again (the user's "Attach"). */
  attach(
    computerId: string,
    sessionId: string
  ): Promise<{ ok: true } | { ok: false; reason: string; detail?: string }>
  /** End it — exactly the attempt listed (the user's "Stop"). */
  kill(
    computerId: string,
    sessionId: string,
    signal?: AbortSignal
  ): Promise<{ ok: true } | { ok: false; reason: string }>
  /** Supersede queued and in-flight adoptions before restarting or disposing a tab. */
  cancelAdoptions(sessionId: string): void
  /** Includes queued and hidden transport-to-manager handoffs. */
  cancelTaskAdoptions(taskId: string): void
  /**
   * The hub was asked to end the tab's session (a restart, reset, respawn, Start
   * fresh) while it tracks none there: end what the computer still runs under that
   * id, on every computer (review M2). `attached`: an adoption in flight attached it
   * meanwhile — the caller ends it as the tab's session.
   */
  killBySession(
    sessionId: string,
    signal?: AbortSignal
  ): Promise<'stopped' | 'attached' | 'none' | 'not-stopped'>
  onChange(cb: () => void): () => void
}

/** Adoptions in flight at once: each is a database read and one computer round-trip. */
const ADOPT_CONCURRENCY = 4

/** `<taskId>:<tabId>` — the main tab's id is the task's. */
function parseTaskTab(sessionId: string): { taskId: string; tabId: string } | null {
  const parts = sessionId.split(':')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  return { taskId: parts[0], tabId: parts[1] }
}

const keyOf = (s: { computerId: string; sessionId: string }): string =>
  `${s.computerId}\u0000${s.sessionId}`

export function createUnattachedSessions(deps: {
  backend: () => PtyBackend
  /** Null until the composition root wires one: then every session is `launch-unresolved`. */
  resolve: (
    target: Parameters<UnattachedLaunchResolver>[0]
  ) => Promise<Awaited<ReturnType<UnattachedLaunchResolver>> | null>
  create: (
    opts: UnattachedLaunch & {
      attach: { computerId: string; spawnId: string; signal?: AbortSignal }
    }
  ) => Promise<PtyCreateResult>
}): UnattachedSessions {
  const entries = new Map<string, UnattachedSession>()
  const listeners = new Set<() => void>()
  /** Reasons already recorded, per attempt: one diagnostic per (session, attempt, reason). */
  const recorded = new Set<string>()
  // Identity outlives its visible row, through the manager ownership commit.
  type Adoption = {
    entry: UnattachedSession
    controller: AbortController
    running: boolean
    done: Promise<void>
    finish: () => void
  }
  let queue: Adoption[] = []
  const adoptions = new Set<Adoption>()
  let running = 0
  let subscription: { dispose(): void } | null = null
  let subscribedTo: PtyBackend | null = null

  const changed = (): void => {
    for (const cb of [...listeners]) {
      try {
        cb()
      } catch {
        /* a listener's failure must not stop the others */
      }
    }
  }

  function surface(entry: UnattachedSession, reason: UnattachedReason, detail?: string): void {
    // It left the set meanwhile (taken over by its tab's own start, exited): nothing
    // to report — it is not a session left unattached (review L1).
    if (entries.get(keyOf(entry)) !== entry) return
    entry.status = 'unattached'
    entry.reason = reason
    if (detail) entry.detail = detail
    else delete entry.detail
    const once = `${keyOf(entry)}\u0000${entry.spawnId ?? ''}\u0000${reason}`
    if (!recorded.has(once)) {
      recorded.add(once)
      recordDiagnosticEvent({
        level: 'warn',
        source: 'pty',
        event: 'pty.orphan_unattached',
        sessionId: entry.sessionId,
        ...(entry.taskId ? { taskId: entry.taskId } : {}),
        message:
          'A terminal session the computer is still running (from before the hub restarted) ' +
          `could not be attached to its tab (${reason}). It keeps running; attach or stop it ` +
          'from Settings or `slay pty unattached`.',
        payload: {
          computerId: entry.computerId,
          spawnId: entry.spawnId ?? null,
          mode: entry.mode ?? null,
          reason,
          detail: detail ?? null
        }
      })
    }
    changed()
  }

  /** Why it cannot even be tried; null when it can. */
  function precheck(entry: UnattachedSession): UnattachedReason | null {
    if (!entry.taskId || !entry.tabId) return 'unknown-session-id'
    if (!entry.detection || !entry.spawnId) return 'no-detection'
    return null
  }

  async function adopt(entry: UnattachedSession, signal: AbortSignal): Promise<boolean | void> {
    const blocked = precheck(entry)
    if (blocked) return surface(entry, blocked)
    const spawnId = entry.spawnId!
    let resolved: Awaited<ReturnType<UnattachedLaunchResolver>> | null
    try {
      resolved = await awaitPtyOperation(
        () =>
          deps.resolve({
            computerId: entry.computerId,
            sessionId: entry.sessionId,
            taskId: entry.taskId!,
            tabId: entry.tabId!,
            ...(entry.mode ? { mode: entry.mode } : {})
          }),
        signal
      )
    } catch (err) {
      if (signal.aborted) return
      return surface(entry, 'launch-unresolved', err instanceof Error ? err.message : String(err))
    }
    if (signal.aborted || entries.get(keyOf(entry)) !== entry) return
    if (!resolved) return surface(entry, 'launch-unresolved', 'no launch resolver')
    if (!resolved.ok) return surface(entry, resolved.reason, resolved.detail)
    // The tab now runs another agent than the process does: not this tab's agent.
    if (entry.mode && resolved.launch.mode !== entry.mode) {
      return surface(
        entry,
        'mode-mismatch',
        `the process runs ${entry.mode}, the tab ${resolved.launch.mode}`
      )
    }
    let result: PtyCreateResult
    try {
      result = await awaitPtyOperation(
        () =>
          deps.create({
            ...resolved.launch,
            attach: { computerId: entry.computerId, spawnId, signal }
          }),
        signal
      )
    } catch (err) {
      if (signal.aborted) return
      return surface(entry, 'launch-unresolved', err instanceof Error ? err.message : String(err))
    }
    if (result.success) {
      // Taken over: the backend no longer lists it (its change removes the entry).
      if (entries.get(keyOf(entry)) === entry) {
        entries.delete(keyOf(entry))
        changed()
      }
      return true
    }
    surface(entry, result.attachRefusal ?? 'launch-unresolved', result.error)
  }

  function retire(job: Adoption): void {
    adoptions.delete(job)
    job.finish()
  }

  function cancelWhere(matches: (entry: UnattachedSession) => boolean): void {
    for (const job of adoptions) {
      if (!matches(job.entry)) continue
      job.controller.abort(new Error('Terminal adoption superseded by disposal or stop.'))
      if (!job.running) retire(job)
      if (job.entry.status === 'adopting') surface(job.entry, 'not-adoptable', 'Stop requested.')
    }
    queue = queue.filter((job) => !job.controller.signal.aborted)
  }

  const cancelAdoptions = (sessionId: string): void =>
    cancelWhere((entry) => entry.sessionId === sessionId)
  const cancelTaskAdoptions = (taskId: string): void =>
    cancelWhere((entry) => entry.taskId === taskId)

  function pump(): void {
    while (running < ADOPT_CONCURRENCY && queue.length > 0) {
      const job = queue.shift()!
      if (job.controller.signal.aborted || entries.get(keyOf(job.entry)) !== job.entry) {
        retire(job)
        continue
      }
      job.running = true
      running++
      void adopt(job.entry, job.controller.signal)
        .then((accepted) => {
          if (!accepted)
            job.controller.abort(new Error('Adoption was not accepted by its manager.'))
        })
        .catch(() => job.controller.abort(new Error('Adoption failed before ownership transfer.')))
        .finally(() => {
          running--
          retire(job)
          pump()
        })
    }
  }

  function schedule(entry: UnattachedSession): Adoption {
    const existing = [...adoptions].find(
      (job) => job.entry === entry && !job.controller.signal.aborted
    )
    if (existing) return existing
    // A newer listed attempt supersedes every older job for this computer/tab.
    cancelWhere((prior) => keyOf(prior) === keyOf(entry))
    entry.status = 'adopting'
    delete entry.reason
    delete entry.detail
    let finish!: () => void
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    const job: Adoption = { entry, controller: new AbortController(), running: false, done, finish }
    adoptions.add(job)
    queue.push(job)
    pump()
    return job
  }

  /** Follow the backend's set: new attempts are adopted, gone ones leave. */
  function sync(): void {
    const listed = deps.backend().untrackedSessions?.() ?? []
    const seen = new Set<string>()
    let dirty = false
    for (const s of listed) {
      const key = keyOf(s)
      seen.add(key)
      const known = entries.get(key)
      if (known && known.spawnId === s.spawnId) {
        Object.assign(known, s)
        continue
      }
      const ids = parseTaskTab(s.sessionId)
      const entry: UnattachedSession = {
        ...s,
        taskId: ids?.taskId ?? null,
        tabId: ids?.tabId ?? null,
        status: 'adopting'
      }
      entries.set(key, entry)
      dirty = true
      schedule(entry)
    }
    for (const key of [...entries.keys()]) {
      if (!seen.has(key)) {
        entries.delete(key)
        dirty = true
      }
    }
    if (dirty) changed()
  }

  const find = (computerId: string, sessionId: string): UnattachedSession | undefined =>
    entries.get(keyOf({ computerId, sessionId }))

  return {
    start() {
      const backend = deps.backend()
      if (subscribedTo === backend) return
      subscription?.dispose()
      subscribedTo = backend
      subscription = backend.onUntrackedChange?.(sync) ?? null
      sync()
    },
    stop() {
      subscription?.dispose()
      subscription = null
      subscribedTo = null
      entries.clear()
      cancelWhere(() => true)
      queue.length = 0
      recorded.clear()
    },
    list: () =>
      [...entries.values()]
        .map((e) => ({ ...e }))
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    async attach(computerId, sessionId) {
      const entry = find(computerId, sessionId)
      if (!entry) return { ok: false, reason: 'not-found' }
      if (entry.status === 'adopting') return { ok: false, reason: 'adopting' }
      entry.status = 'adopting'
      delete entry.reason
      delete entry.detail
      changed()
      const job = schedule(entry)
      await job.done
      if (job.controller.signal.aborted) return { ok: false, reason: 'not-adoptable' }
      if (!entries.has(keyOf(entry))) return { ok: true }
      return {
        ok: false,
        reason: entry.reason ?? 'launch-unresolved',
        ...(entry.detail ? { detail: entry.detail } : {})
      }
    },
    cancelAdoptions,
    cancelTaskAdoptions,
    async kill(computerId, sessionId, signal) {
      // Being attached right now: wait for that first. Attached = it is its tab's
      // session now, stopped (if at all) there — never behind the tab's back.
      const jobs = [...adoptions].filter(
        (job) => keyOf(job.entry) === keyOf({ computerId, sessionId })
      )
      const adopting = jobs.length ? Promise.all(jobs.map((job) => job.done)) : null
      if (adopting) await awaitPtyOperation(() => adopting, signal)
      signal?.throwIfAborted()
      const entry = find(computerId, sessionId)
      if (!entry)
        return {
          ok: false,
          reason: jobs.some((job) => !job.controller.signal.aborted) ? 'attached' : 'not-found'
        }
      const backend = deps.backend()
      if (!entry.spawnId || !backend.killUntracked) return { ok: false, reason: 'no-attempt-key' }
      const { stopped } = await awaitPtyOperation(
        () => backend.killUntracked!(entry.computerId, entry.sessionId, entry.spawnId!, signal),
        signal
      )
      signal?.throwIfAborted()
      // Another attempt runs it now (the set lists that one), or the computer could
      // not say: never reported as stopped (review M1).
      if (!stopped) return { ok: false, reason: 'not-stopped' }
      recordDiagnosticEvent({
        level: 'info',
        source: 'pty',
        event: 'pty.orphan_killed',
        sessionId: entry.sessionId,
        ...(entry.taskId ? { taskId: entry.taskId } : {}),
        message: 'Stopped a terminal session left running from before the hub restarted.',
        payload: {
          computerId: entry.computerId,
          sessionId: entry.sessionId,
          spawnId: entry.spawnId,
          mode: entry.mode ?? null
        }
      })
      if (entries.get(keyOf(entry)) === entry) {
        entries.delete(keyOf(entry))
        changed()
      }
      return { ok: true }
    },
    async killBySession(sessionId, signal) {
      cancelAdoptions(sessionId)
      const computers = [
        ...new Set(
          [...entries.values()].filter((e) => e.sessionId === sessionId).map((e) => e.computerId)
        )
      ]
      if (computers.length === 0) return 'none'
      let outcome: 'stopped' | 'attached' | 'none' | 'not-stopped' = 'none'
      const results = await Promise.all(
        computers.map((computerId) => this.kill(computerId, sessionId, signal))
      )
      for (const r of results) {
        if (r.ok) {
          if (outcome === 'none') outcome = 'stopped'
        } else if (r.reason === 'attached') outcome = 'attached'
        else if (r.reason === 'not-stopped') outcome = 'not-stopped'
      }
      return outcome
    },
    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
}
