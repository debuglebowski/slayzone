/**
 * Config changes must reach the OTHER process that writes this machine's
 * diagnostics database.
 *
 * Two instances of this module record into the same machine-local
 * `slayzone[.dev].diagnostics.sqlite`: the hub (config in the shared DB) and the
 * Electron host (config in the client store). The renderer's Settings UI writes
 * over tRPC, which the hub serves — so before this, turning diagnostics OFF
 * stopped the hub recording while the HOST kept writing from a client store that
 * never changed. Same file, two configs, one of them permanently stale.
 *
 * `onConfigChanged` is the seam that closes it: the hub forwards each saved
 * config to the host over the capability bridge, and the host persists it to the
 * client store. Tested here rather than at the router because the notification
 * must fire for EVERY config write, not just the one transport that exists today.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *     --experimental-loader ./packages/shared/test-utils/loader.ts \
 *     packages/domains/diagnostics/src/server/config-push.test.ts
 */
import { test, expect } from '../../../../shared/test-utils/ipc-harness.js'
import type { SlayzoneDb } from '@slayzone/platform'
import type { DiagnosticsConfig } from '../shared/index.js'
import { bindDiagnosticsDbs, saveDiagnosticsConfig, clearConfigCache } from './diagnostics-store.js'

/**
 * Map-backed stand-in for the settings table. `getSetting`/`setSetting` only ever
 * touch `prepare().get()` / `prepare().run()`, so a real database would add
 * nothing but a temp file.
 */
function fakeSettingsDb(): SlayzoneDb & { rows: Map<string, string> } {
  const rows = new Map<string, string>()
  const db = {
    rows,
    prepare(sql: string) {
      return {
        get: async (key: string) => {
          if (!/SELECT value FROM settings/i.test(sql)) throw new Error(`unexpected sql: ${sql}`)
          const value = rows.get(key)
          return value === undefined ? undefined : { value }
        },
        run: async (key: string, value: string) => {
          rows.set(key, value)
          return { changes: 1, lastInsertRowid: 0 }
        },
        all: async () => []
      }
    }
  }
  return db as unknown as SlayzoneDb & { rows: Map<string, string> }
}

/** The diagnostics DB is irrelevant here — nothing in these paths records events. */
const noopDiagDb = { prepare: () => ({ get: async () => undefined, run: async () => ({}) }) }

test('hub-side save notifies with the FULL merged config, not the partial', async () => {
  const seen: DiagnosticsConfig[] = []
  const settingsDb = fakeSettingsDb()
  clearConfigCache()
  bindDiagnosticsDbs({
    settingsDb,
    diagnosticsDb: noopDiagDb as unknown as SlayzoneDb,
    onConfigChanged: (next) => {
      seen.push(next)
    }
  })

  await saveDiagnosticsConfig({ enabled: false })

  expect(seen.length).toBe(1)
  // The host is setting its whole config from this, so a partial would silently
  // reset the three fields it omits.
  expect(seen[0].enabled).toBe(false)
  expect(seen[0].verbose).toBe(false)
  expect(seen[0].includePtyOutput).toBe(false)
  expect(seen[0].retentionDays).toBe(14)
})

test('notifies AFTER the value is persisted, never before', async () => {
  const settingsDb = fakeSettingsDb()
  let persistedAtNotifyTime: string | undefined
  clearConfigCache()
  bindDiagnosticsDbs({
    settingsDb,
    diagnosticsDb: noopDiagDb as unknown as SlayzoneDb,
    onConfigChanged: () => {
      persistedAtNotifyTime = settingsDb.rows.get('diagnostics_retention_days')
    }
  })

  await saveDiagnosticsConfig({ retentionDays: 30 })

  // Notifying first would let the host adopt a config a crash could still lose.
  expect(persistedAtNotifyTime).toBe('30')
})

test('a THROWING listener does not fail the save', async () => {
  const settingsDb = fakeSettingsDb()
  clearConfigCache()
  bindDiagnosticsDbs({
    settingsDb,
    diagnosticsDb: noopDiagDb as unknown as SlayzoneDb,
    onConfigChanged: () => {
      // The real listener crosses the capability bridge; a dead side-car must not
      // turn a successful, already-persisted save into a failed mutation.
      throw new Error('bridge is down')
    }
  })

  const next = await saveDiagnosticsConfig({ verbose: true })

  expect(next.verbose).toBe(true)
  expect(settingsDb.rows.get('diagnostics_verbose')).toBe('1')
})

test('client-store save notifies too — one seam, both bindings', async () => {
  const seen: DiagnosticsConfig[] = []
  let stored: Partial<DiagnosticsConfig> = {}
  clearConfigCache()
  bindDiagnosticsDbs({
    diagnosticsDb: noopDiagDb as unknown as SlayzoneDb,
    localConfig: () => stored,
    saveLocalConfig: async (next) => {
      stored = next
    },
    onConfigChanged: (next) => {
      seen.push(next)
    }
  })

  await saveDiagnosticsConfig({ retentionDays: 7 })

  expect(seen.length).toBe(1)
  expect(seen[0].retentionDays).toBe(7)
  expect(stored.retentionDays).toBe(7)
})

test('an unbound listener is not required — save still works', async () => {
  const settingsDb = fakeSettingsDb()
  clearConfigCache()
  bindDiagnosticsDbs({ settingsDb, diagnosticsDb: noopDiagDb as unknown as SlayzoneDb })

  const next = await saveDiagnosticsConfig({ enabled: false })

  expect(next.enabled).toBe(false)
})
