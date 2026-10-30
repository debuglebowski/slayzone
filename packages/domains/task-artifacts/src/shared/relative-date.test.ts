import { describe, expect, it } from 'vitest'
import { dbTimestampToIso, formatRelativeDate } from './relative-date'

describe('formatRelativeDate', () => {
  const now = new Date('2026-10-30T12:00:00Z')

  it('says how long ago, in the coarsest unit under a week', () => {
    expect(formatRelativeDate('2026-10-30T11:59:40Z', now)).toBe('just now')
    expect(formatRelativeDate('2026-10-30T11:15:00Z', now)).toBe('45m ago')
    expect(formatRelativeDate('2026-10-30T07:00:00Z', now)).toBe('5h ago')
    expect(formatRelativeDate('2026-10-27T12:00:00Z', now)).toBe('3d ago')
  })

  it('names the day for anything a week old or older', () => {
    const expected = new Date('2026-10-01T12:00:00Z').toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric'
    })
    expect(formatRelativeDate('2026-10-01T12:00:00Z', now)).toBe(expected)
  })
})

describe('dbTimestampToIso', () => {
  it("reads SQLite's datetime('now') (UTC, no zone) as UTC", () => {
    expect(dbTimestampToIso('2026-10-30 10:00:00')).toBe('2026-10-30T10:00:00Z')
    expect(dbTimestampToIso('2026-10-30 10:00:00.123')).toBe('2026-10-30T10:00:00.123Z')
  })

  it('leaves a value that already names its zone alone', () => {
    expect(dbTimestampToIso('2026-10-30T10:00:00.000Z')).toBe('2026-10-30T10:00:00.000Z')
    expect(dbTimestampToIso('2026-10-30T10:00:00+02:00')).toBe('2026-10-30T10:00:00+02:00')
  })
})
