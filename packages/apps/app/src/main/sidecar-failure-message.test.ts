import { describe, expect, it } from 'vitest'
import { sidecarFailureMessage } from './sidecar-failure-message'

const base = {
  message: 'SqliteError: duplicate column name: opened_at',
  storageDir: '/root/hub',
  dbPath: '/root/hub/slayzone.data.sqlite',
  attempts: 5
}

describe('sidecarFailureMessage', () => {
  it('no restore involved: the data was not modified (migrations are atomic)', () => {
    const text = sidecarFailureMessage({ ...base, exists: () => false })
    expect(text).toContain('Your data has not been modified')
    expect(text).toContain('/root/hub/backups')
    expect(text).toContain('Attempts: 5')
  })

  it('a restore was being applied: never claims "not modified", names where the previous data is', () => {
    const text = sidecarFailureMessage({
      ...base,
      exists: (p) => p === '/root/hub/slayzone.data.sqlite.pre-restore'
    })
    expect(text).not.toContain('has not been modified')
    expect(text).toContain('backup restore')
    expect(text).toContain('/root/hub/slayzone.data.sqlite.pre-restore')
    expect(text).toMatch(/put back/)
  })

  it('a restore staged but not swapped in yet: the live file is untouched', () => {
    const text = sidecarFailureMessage({
      ...base,
      exists: (p) => p === '/root/hub/restore.pending.json'
    })
    expect(text).toContain('backup restore')
    expect(text).toContain('/root/hub/slayzone.data.sqlite')
  })
})
