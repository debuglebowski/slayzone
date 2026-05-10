import type { Project } from '../shared/types'

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
  const log = (taskOpenLog.get(project.id) ?? []).filter(t => t > windowStart)
  taskOpenLog.set(project.id, log) // prune old entries
  return log.length >= cfg.max_tasks
}

// Session-only lock overrides — reset on app restart
const durationOverrides = new Set<string>()
const scheduleOverrides = new Set<string>()

export function overrideDurationLock(projectId: string): void {
  durationOverrides.add(projectId)
}

export function overrideScheduleLock(projectId: string): void {
  scheduleOverrides.add(projectId)
}

export function clearLockOverrides(projectId: string): void {
  durationOverrides.delete(projectId)
  scheduleOverrides.delete(projectId)
}

function parseHHMM(s: string): number {
  const [h, m] = s.split(':').map(Number)
  return h * 60 + m
}

function isWithinDuration(lockedUntil: string | null | undefined): boolean {
  if (!lockedUntil) return false
  return new Date(lockedUntil).getTime() > Date.now()
}

function isWithinSchedule(sched: { from: string; to: string; weekdays?: boolean[] } | null | undefined): boolean {
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
    if (sched.weekdays.every(d => !d)) return false
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
  if (durationOverrides.has(project.id)) return false
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
  if (durationOverrides.has(project.id) && isWithinDuration(project.lock_config?.locked_until)) return true
  if (scheduleOverrides.has(project.id) && isWithinSchedule(project.lock_config?.schedule)) return true
  return false
}
