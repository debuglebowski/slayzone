/**
 * SettingsService cache coherence.
 *
 * These pin the two properties SYNC readers depend on. The idle-close
 * (hibernation) getter in the side-car composition is exactly such a reader: it
 * is called per sweep tick, cannot await, and reads `getCached`. If either
 * property below breaks, that getter silently returns a stale config and
 * hibernation stops matching what the user set — with no error anywhere.
 *
 * Run with: npx vitest run packages/domains/settings/src/server/service.test.ts
 */
import { describe, expect, it } from 'vitest'
import type { SlayzoneDb } from '@slayzone/platform'
import { SettingsService } from './service'

/** Minimal in-memory stand-in for the `prepare(...).get/run/all` surface used. */
function fakeDb(seed: Record<string, string> = {}): SlayzoneDb {
  const rows = new Map(Object.entries(seed))
  return {
    prepare(sql: string) {
      return {
        async get(key: string) {
          if (!/SELECT value FROM settings/.test(sql)) return undefined
          const value = rows.get(key)
          return value === undefined ? undefined : { value }
        },
        async run(key: string, value: string) {
          if (/INSERT OR REPLACE INTO settings/.test(sql)) rows.set(key, value)
          return { changes: 1, lastInsertRowid: 0 }
        },
        async all() {
          return [...rows].map(([key, value]) => ({ key, value }))
        }
      }
    }
  } as unknown as SlayzoneDb
}

describe('SettingsService', () => {
  it('is one instance per db handle, so caches cannot fork', () => {
    const db = fakeDb()
    // A second instance would hold a PRIVATE cache: writes through one would be
    // invisible to sync readers holding the other, which is the silent-staleness
    // failure the private constructor exists to prevent.
    expect(SettingsService.forDatabase(db)).toBe(SettingsService.forDatabase(db))
    expect(SettingsService.forDatabase(fakeDb())).not.toBe(SettingsService.forDatabase(db))
  })

  it('set() is write-through for warmed keys, so a sync reader sees a UI toggle immediately', async () => {
    const db = fakeDb({ terminal_auto_close_idle: '0' })
    const svc = SettingsService.forDatabase(db)
    await svc.warmCache(['terminal_auto_close_idle'])
    expect(svc.getCached('terminal_auto_close_idle')).toBe('0')

    // The settings router mutates THIS instance. No event is emitted on set()
    // (`settings-changed` fires only from notifyRenderer), so write-through is the
    // ONLY thing keeping a sync reader current — there is no second mechanism.
    await svc.set('terminal_auto_close_idle', '1')
    expect(svc.getCached('terminal_auto_close_idle')).toBe('1')
  })

  it('getCached throws for an un-warmed key rather than reporting a false default', () => {
    const svc = SettingsService.forDatabase(fakeDb({ some_key: 'v' }))
    // Returning undefined here would read as "feature off" at a call site doing
    // `=== '1'`, turning a wiring mistake into silent misbehaviour.
    expect(() => svc.getCached('some_key')).toThrow(/not pre-warmed/)
  })

  it('an un-warmed key is NOT retro-cached by set() (write-through is opt-in per key)', async () => {
    const svc = SettingsService.forDatabase(fakeDb())
    await svc.set('never_warmed', '1')
    // Still throws: `set` only updates keys someone warmed. Documents why a reader
    // must warm every key it intends to read, not just the ones it writes.
    expect(() => svc.getCached('never_warmed')).toThrow(/not pre-warmed/)
    expect(await svc.get('never_warmed')).toBe('1')
  })
})
