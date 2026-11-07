import { RetryPolicy, type RetryState } from '@slayzone/computer-runtime'

export class HostMaintenanceRequired extends Error {}

export interface UpgradeWorker {
  drain(): Promise<boolean>
  stop(): Promise<void>
  connected(): Promise<void>
  activate?(): void | Promise<void>
  probation?(ms: number): Promise<void>
  exited?: () => boolean
}
export interface UpgradeRelease {
  version: string
  entry: string
}
export type UpgradePhase =
  | 'checking'
  | 'installing'
  | 'waiting-for-idle'
  | 'restarting'
  | 'probation'
  | 'connected'
  | 'rollback'
  | 'failed'
  | 'maintenance-required'
export interface UpgradeDeps {
  discover(): Promise<string>
  install(version: string): Promise<string>
  validate?(release: UpgradeRelease): Promise<void>
  launch(entry: string, probation?: boolean): UpgradeWorker
  commit(release: UpgradeRelease, previous?: UpgradeRelease): Promise<void>
  status(phase: UpgradePhase, detail: Record<string, unknown>): void
  probationMs?: number
  now?: () => number
  retry?: boolean
  recordRetry?: (state: RetryState) => Promise<void>
  recordCrashes?: (times: number[]) => Promise<void>
}
export function createUpgradeController(
  initial: UpgradeRelease & {
    worker: UpgradeWorker
    previous?: UpgradeRelease
    retryState?: RetryState
    crashes?: number[]
  },
  deps: UpgradeDeps
) {
  let current = initial
  let previous = initial.previous
  let staged: UpgradeRelease | undefined
  let checking = false
  let stopping = false
  let pending: UpgradeWorker | undefined
  let crashes: number[] = initial.crashes ?? []
  const retry = new RetryPolicy(Math.random, initial.retryState)
  const now = deps.now ?? Date.now
  const fail = async (target: string, err: unknown, quarantine = false): Promise<void> => {
    const delay = quarantine ? retry.quarantine(target, now()) : retry.fail(target, now())
    await deps.recordRetry?.(retry.snapshot())
    deps.status('failed', {
      target,
      error: err instanceof Error ? err.message : String(err),
      retryAt: now() + delay
    })
  }
  const rollback = async (bad: UpgradeRelease): Promise<void> => {
    if (!previous) return
    await current.worker.stop()
    const fallback = previous
    pending = deps.launch(fallback.entry, true)
    try {
      await pending.connected()
      await pending.activate?.()
    } catch {
      /* An old protocol may be incompatible. Keep the host and recovery loop alive. */
    }
    await deps.commit(fallback)
    current = { ...fallback, worker: pending }
    pending = undefined
    previous = undefined
    crashes = []
    await fail(bad.version, new Error('release quarantined after repeated startup crashes'), true)
  }
  return {
    async check(): Promise<void> {
      if (checking || stopping) return
      checking = true
      let target = 'discovery'
      try {
        if (current.worker.exited?.()) {
          crashes = [...crashes.filter((t) => now() - t < 600_000), now()]
          await deps.recordCrashes?.(crashes)
          if (crashes.length >= 3 && previous) {
            deps.status('rollback', { version: current.version, target: previous.version })
            await rollback(current)
            return
          }
          current.worker = deps.launch(current.entry)
        }
        if (
          deps.retry !== false &&
          retry.snapshot().target === 'discovery' &&
          !retry.ready('discovery', now())
        )
          return
        target = await deps.discover()
        if (stopping || (deps.retry !== false && !retry.ready(target, now()))) return
        deps.status('checking', { version: current.version })
        if (target === current.version) {
          await current.worker.connected()
          deps.status('connected', { version: current.version })
          return
        }
        if (staged?.version !== target) {
          deps.status('installing', { target })
          staged = { version: target, entry: await deps.install(target) }
        }
        if (stopping) return
        await deps.validate?.(staged)
        if (stopping) return
        // Never replace a connector mid-enrollment: stopped between the hub's reply and
        // saving its credential, it leaves the hub an enrollment nobody holds, and the
        // candidate enrolls again (a second computer; a single-use join token is spent).
        // Connected (credential saved) or refused (e.g. its protocol): either settles it.
        await current.worker.connected().catch(() => undefined)
        if (stopping) return
        if (!(await current.worker.drain())) {
          deps.status('waiting-for-idle', { target })
          return
        }
        deps.status('restarting', { target })
        const old = current
        await old.worker.stop()
        if (stopping) return
        const candidate = (pending = deps.launch(staged.entry, true))
        try {
          await candidate.connected()
          if (stopping) return
          await candidate.activate?.()
          deps.status('probation', { target })
          await candidate.probation?.(deps.probationMs ?? 60_000)
          if (stopping) return
          await deps.commit(staged, { version: old.version, entry: old.entry })
          previous = { version: old.version, entry: old.entry }
          current = { ...staged, worker: candidate }
          crashes = []
          await deps.recordCrashes?.([])
          retry.reset()
          await deps.recordRetry?.(retry.snapshot())
          deps.status('connected', { version: current.version })
        } catch (err) {
          await candidate.stop()
          if (!stopping) current = { ...old, worker: deps.launch(old.entry) }
          staged = undefined
          throw err
        } finally {
          if (stopping) await candidate.stop()
          pending = undefined
        }
      } catch (err) {
        if (!stopping) {
          if (err instanceof HostMaintenanceRequired)
            deps.status('maintenance-required', { target, maintenanceReason: err.message })
          else await fail(target, err)
        }
      } finally {
        checking = false
        if (stopping) await current.worker.stop()
      }
    },
    async stop(): Promise<void> {
      stopping = true
      await Promise.all([current.worker.stop(), pending?.stop()])
    }
  }
}
