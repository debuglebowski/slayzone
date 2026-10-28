import { useCallback, useSyncExternalStore } from 'react'
import type { Project } from '@slayzone/projects-contracts'

// Module-scoped — no DB writes, no re-render cascade, resets on restart
const taskOpenLog = new Map<string, number[]>()

export function recordTaskOpen(projectId: string): void {
  const log = taskOpenLog.get(projectId) ?? []
  log.push(Date.now())
  taskOpenLog.set(projectId, log)
}

export function isRateLimited(project: Project): boolean {
  const cfg = project.lock_config?.rate_limit
  if (!cfg) return false
  const windowStart = Date.now() - cfg.per_minutes * 60_000
  const log = (taskOpenLog.get(project.id) ?? []).filter((t) => t > windowStart)
  taskOpenLog.set(project.id, log) // prune old entries
  return log.length >= cfg.max_tasks
}

// Session-only lock overrides — reset on app restart
// A duration override belongs to the lock it unlocked (projectId → that lock's
// locked_until): a NEW lock set later in the session is enforced again.
const durationOverrides = new Map<string, string>()
const scheduleOverrides = new Set<string>()

export function overrideDurationLock(
  projectId: string,
  lockedUntil: string | null | undefined
): void {
  if (!lockedUntil) return
  durationOverrides.set(projectId, lockedUntil)
  notifyLockChange()
}

function isDurationOverridden(project: Project): boolean {
  const lockedUntil = project.lock_config?.locked_until
  return !!lockedUntil && durationOverrides.get(project.id) === lockedUntil
}

export function overrideScheduleLock(projectId: string): void {
  scheduleOverrides.add(projectId)
  notifyLockChange()
}

export function clearLockOverrides(projectId: string): void {
  durationOverrides.delete(projectId)
  scheduleOverrides.delete(projectId)
  notifyLockChange()
}

function parseHHMM(s: string): number {
  const [h, m] = s.split(':').map(Number)
  return h * 60 + m
}

function isWithinDuration(lockedUntil: string | null | undefined): boolean {
  if (!lockedUntil) return false
  return new Date(lockedUntil).getTime() > Date.now()
}

function isWithinSchedule(
  sched: { from: string; to: string; weekdays?: boolean[] } | null | undefined
): boolean {
  if (!sched) return false
  const now = new Date()
  const current = now.getHours() * 60 + now.getMinutes()
  const from = parseHHMM(sched.from)
  const to = parseHHMM(sched.to)
  const today = now.getDay()
  // Weekday gating uses the schedule's start day. Missing weekdays array = all days active (back-compat).
  // All-false array = effectively disabled.
  const isStartDayActive = (dayIdx: number): boolean => {
    if (!sched.weekdays) return true
    if (sched.weekdays.length !== 7) return true
    if (sched.weekdays.every((d) => !d)) return false
    return !!sched.weekdays[dayIdx]
  }
  if (from <= to) {
    // same-day: 09:00–17:00 — gated by today
    return isStartDayActive(today) && current >= from && current < to
  }
  // overnight: 18:00–09:00 — after `from` gated by today; before `to` gated by yesterday (the start day)
  if (current >= from) return isStartDayActive(today)
  if (current < to) return isStartDayActive((today + 6) % 7)
  return false
}

export function isProjectDurationLocked(project: Project | null | undefined): boolean {
  if (!project) return false
  if (isDurationOverridden(project)) return false
  return isWithinDuration(project.lock_config?.locked_until)
}

export function isScheduleLocked(project: Project | null | undefined): boolean {
  if (!project) return false
  if (scheduleOverrides.has(project.id)) return false
  return isWithinSchedule(project.lock_config?.schedule)
}

export function isProjectLocked(project: Project | null | undefined): boolean {
  return isProjectDurationLocked(project) || isScheduleLocked(project)
}

export const PROJECT_LOCKED_TOAST = 'Project is locked — cannot open new tabs'

export function hasActiveLockOverride(project: Project | null | undefined): boolean {
  if (!project) return false
  if (isDurationOverridden(project) && isWithinDuration(project.lock_config?.locked_until))
    return true
  if (scheduleOverrides.has(project.id) && isWithinSchedule(project.lock_config?.schedule))
    return true
  return false
}

// ── Reactive read for components ────────────────────────────────────────────
// Lock state depends on the wall clock and the session-only overrides above —
// neither is visible to React. Calling isProjectLocked() during render gets
// memoized by the React Compiler on the project object, so an expired or
// overridden lock never cleared on screen. Components read it through
// useProjectLockState instead: it re-renders on override changes and at the
// moments the state can flip by itself (lock expiry, schedule minute boundaries).

const lockListeners = new Set<() => void>()

function notifyLockChange(): void {
  for (const listener of lockListeners) listener()
}

/** setTimeout's max delay (2^31 − 1 ms ≈ 24.8 days); longer waits re-arm. */
const MAX_TIMEOUT_MS = 2_147_483_647

/** ms until `project`'s lock state may change by itself, or null if it never will. */
function msUntilLockBoundary(project: Project): number | null {
  const now = Date.now()
  const waits: number[] = []
  const lockedUntil = project.lock_config?.locked_until
  if (lockedUntil) {
    const ms = new Date(lockedUntil).getTime() - now
    if (ms > 0) waits.push(ms + 1)
  }
  // Schedules are minute-granular (HH:MM): re-check just past each minute boundary.
  if (project.lock_config?.schedule) waits.push(60_000 - (now % 60_000) + 1)
  return waits.length > 0 ? Math.min(...waits, MAX_TIMEOUT_MS) : null
}

const LOCKED = 1
const OVERRIDE_ACTIVE = 2

function lockSnapshot(project: Project | null | undefined): number {
  if (!project) return 0
  return (
    (isProjectLocked(project) ? LOCKED : 0) | (hasActiveLockOverride(project) ? OVERRIDE_ACTIVE : 0)
  )
}

export interface ProjectLockState {
  /** Duration- or schedule-locked right now (overrides applied). */
  locked: boolean
  /** An early-unlock override is in effect inside an active lock window. */
  overrideActive: boolean
}

export function useProjectLockState(project: Project | null | undefined): ProjectLockState {
  const subscribe = useCallback(
    (onChange: () => void) => {
      lockListeners.add(onChange)
      let timer: ReturnType<typeof setTimeout> | undefined
      const arm = (): void => {
        const ms = project ? msUntilLockBoundary(project) : null
        if (ms !== null) {
          timer = setTimeout(() => {
            onChange()
            arm()
          }, ms)
        }
      }
      arm()
      return () => {
        lockListeners.delete(onChange)
        clearTimeout(timer)
      }
    },
    [project]
  )
  const bits = useSyncExternalStore(subscribe, () => lockSnapshot(project))
  return { locked: (bits & LOCKED) !== 0, overrideActive: (bits & OVERRIDE_ACTIVE) !== 0 }
}
