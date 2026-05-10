/**
 * Project lock guard utility tests
 * Run with: npx tsx packages/domains/projects/src/client/useProjectLockGuard.test.ts
 */
import { describe, expect, test } from '../../../../shared/test-utils/ipc-harness.js'
import type { Project, ProjectLockConfig } from '../shared/types.js'
import {
  isProjectDurationLocked,
  isScheduleLocked,
  hasActiveLockOverride,
  overrideDurationLock,
  overrideScheduleLock,
  clearLockOverrides,
  isRateLimited,
  recordTaskOpen,
} from './useProjectLockGuard.js'

let nextId = 0
const newId = () => `test-project-${++nextId}`

function makeProject(id: string, lock_config: ProjectLockConfig | null): Project {
  return {
    id,
    name: 'Test',
    color: '#000',
    path: null,
    auto_create_worktree_on_task_create: null,
    worktree_source_branch: null,
    worktree_copy_behavior: null,
    worktree_copy_paths: null,
    columns_config: null,
    execution_context: null,
    selected_repo: null,
    task_automation_config: null,
    lock_config,
    icon_letters: null,
    icon_image_path: null,
    sort_order: 0,
    created_at: '',
    updated_at: '',
  }
}

const futureIso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString()
const pastIso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

// Build a schedule that always covers "now" — from one minute ago to one hour from now.
function activeSchedule(): { from: string; to: string } {
  const now = new Date()
  const past = new Date(now.getTime() - 60_000)
  const future = new Date(now.getTime() + 3_600_000)
  const fmt = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return { from: fmt(past), to: fmt(future) }
}

// Build a schedule that does not cover "now" — from one hour from now to two hours from now.
function inactiveSchedule(): { from: string; to: string } {
  const now = new Date()
  const start = new Date(now.getTime() + 3_600_000)
  const end = new Date(now.getTime() + 7_200_000)
  const fmt = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return { from: fmt(start), to: fmt(end) }
}

describe('isProjectDurationLocked', () => {
  test('null project → false', () => {
    expect(isProjectDurationLocked(null)).toBeFalsy()
  })

  test('no lock_config → false', () => {
    const p = makeProject(newId(), null)
    expect(isProjectDurationLocked(p)).toBeFalsy()
  })

  test('locked_until in the future → true', () => {
    const p = makeProject(newId(), { locked_until: futureIso(60_000), rate_limit: null, schedule: null })
    expect(isProjectDurationLocked(p)).toBeTruthy()
  })

  test('locked_until in the past → false', () => {
    const p = makeProject(newId(), { locked_until: pastIso(60_000), rate_limit: null, schedule: null })
    expect(isProjectDurationLocked(p)).toBeFalsy()
  })

  test('override suppresses active duration lock', () => {
    const p = makeProject(newId(), { locked_until: futureIso(60_000), rate_limit: null, schedule: null })
    overrideDurationLock(p.id)
    expect(isProjectDurationLocked(p)).toBeFalsy()
    clearLockOverrides(p.id)
  })

  test('clearLockOverrides re-enables duration lock', () => {
    const p = makeProject(newId(), { locked_until: futureIso(60_000), rate_limit: null, schedule: null })
    overrideDurationLock(p.id)
    clearLockOverrides(p.id)
    expect(isProjectDurationLocked(p)).toBeTruthy()
  })
})

describe('isScheduleLocked', () => {
  test('null project → false', () => {
    expect(isScheduleLocked(null)).toBeFalsy()
  })

  test('no schedule → false', () => {
    const p = makeProject(newId(), { locked_until: null, rate_limit: null, schedule: null })
    expect(isScheduleLocked(p)).toBeFalsy()
  })

  test('schedule covering now → true', () => {
    const p = makeProject(newId(), { locked_until: null, rate_limit: null, schedule: activeSchedule() })
    expect(isScheduleLocked(p)).toBeTruthy()
  })

  test('schedule outside now → false', () => {
    const p = makeProject(newId(), { locked_until: null, rate_limit: null, schedule: inactiveSchedule() })
    expect(isScheduleLocked(p)).toBeFalsy()
  })

  test('override suppresses active schedule lock', () => {
    const p = makeProject(newId(), { locked_until: null, rate_limit: null, schedule: activeSchedule() })
    overrideScheduleLock(p.id)
    expect(isScheduleLocked(p)).toBeFalsy()
    clearLockOverrides(p.id)
  })

  test('weekdays missing → behaves as all days active (back-compat)', () => {
    const p = makeProject(newId(), { locked_until: null, rate_limit: null, schedule: activeSchedule() })
    expect(isScheduleLocked(p)).toBeTruthy()
  })

  test('weekdays today=false → not locked even within time window', () => {
    const today = new Date().getDay()
    const weekdays = Array(7).fill(true)
    weekdays[today] = false
    const p = makeProject(newId(), {
      locked_until: null,
      rate_limit: null,
      schedule: { ...activeSchedule(), weekdays },
    })
    expect(isScheduleLocked(p)).toBeFalsy()
  })

  test('weekdays today=true → locked within time window', () => {
    const today = new Date().getDay()
    const weekdays = Array(7).fill(false)
    weekdays[today] = true
    const p = makeProject(newId(), {
      locked_until: null,
      rate_limit: null,
      schedule: { ...activeSchedule(), weekdays },
    })
    expect(isScheduleLocked(p)).toBeTruthy()
  })

  test('weekdays all-false → never locked', () => {
    const p = makeProject(newId(), {
      locked_until: null,
      rate_limit: null,
      schedule: { ...activeSchedule(), weekdays: Array(7).fill(false) },
    })
    expect(isScheduleLocked(p)).toBeFalsy()
  })

  test('weekdays length != 7 → behaves as missing (back-compat)', () => {
    const p = makeProject(newId(), {
      locked_until: null,
      rate_limit: null,
      schedule: { ...activeSchedule(), weekdays: [true, true] },
    })
    expect(isScheduleLocked(p)).toBeTruthy()
  })
})

describe('hasActiveLockOverride', () => {
  test('null project → false', () => {
    expect(hasActiveLockOverride(null)).toBeFalsy()
  })

  test('no override → false', () => {
    const p = makeProject(newId(), { locked_until: futureIso(60_000), rate_limit: null, schedule: null })
    expect(hasActiveLockOverride(p)).toBeFalsy()
  })

  test('duration override + active duration → true', () => {
    const p = makeProject(newId(), { locked_until: futureIso(60_000), rate_limit: null, schedule: null })
    overrideDurationLock(p.id)
    expect(hasActiveLockOverride(p)).toBeTruthy()
    clearLockOverrides(p.id)
  })

  test('duration override on expired lock → false', () => {
    const p = makeProject(newId(), { locked_until: pastIso(60_000), rate_limit: null, schedule: null })
    overrideDurationLock(p.id)
    expect(hasActiveLockOverride(p)).toBeFalsy()
    clearLockOverrides(p.id)
  })

  test('schedule override + active schedule → true', () => {
    const p = makeProject(newId(), { locked_until: null, rate_limit: null, schedule: activeSchedule() })
    overrideScheduleLock(p.id)
    expect(hasActiveLockOverride(p)).toBeTruthy()
    clearLockOverrides(p.id)
  })

  test('schedule override on inactive schedule → false', () => {
    const p = makeProject(newId(), { locked_until: null, rate_limit: null, schedule: inactiveSchedule() })
    overrideScheduleLock(p.id)
    expect(hasActiveLockOverride(p)).toBeFalsy()
    clearLockOverrides(p.id)
  })

  test('clearLockOverrides drops both override types', () => {
    const p = makeProject(newId(), { locked_until: futureIso(60_000), rate_limit: null, schedule: activeSchedule() })
    overrideDurationLock(p.id)
    overrideScheduleLock(p.id)
    clearLockOverrides(p.id)
    expect(isProjectDurationLocked(p)).toBeTruthy()
    expect(isScheduleLocked(p)).toBeTruthy()
    expect(hasActiveLockOverride(p)).toBeFalsy()
  })
})

describe('isRateLimited', () => {
  test('no rate_limit → false', () => {
    const p = makeProject(newId(), { locked_until: null, rate_limit: null, schedule: null })
    expect(isRateLimited(p)).toBeFalsy()
  })

  test('under limit → false', () => {
    const p = makeProject(newId(), { locked_until: null, rate_limit: { max_tasks: 3, per_minutes: 60 }, schedule: null })
    recordTaskOpen(p.id)
    recordTaskOpen(p.id)
    expect(isRateLimited(p)).toBeFalsy()
  })

  test('at limit → true', () => {
    const p = makeProject(newId(), { locked_until: null, rate_limit: { max_tasks: 2, per_minutes: 60 }, schedule: null })
    recordTaskOpen(p.id)
    recordTaskOpen(p.id)
    expect(isRateLimited(p)).toBeTruthy()
  })

  test('separate projects do not interfere', () => {
    const a = makeProject(newId(), { locked_until: null, rate_limit: { max_tasks: 1, per_minutes: 60 }, schedule: null })
    const b = makeProject(newId(), { locked_until: null, rate_limit: { max_tasks: 1, per_minutes: 60 }, schedule: null })
    recordTaskOpen(a.id)
    expect(isRateLimited(a)).toBeTruthy()
    expect(isRateLimited(b)).toBeFalsy()
  })
})
