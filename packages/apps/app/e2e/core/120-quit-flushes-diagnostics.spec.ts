import fs from 'fs'
import path from 'path'
// node:sqlite, not better-sqlite3: the repo's native build targets Electron's ABI, not Playwright's Node.
import { DatabaseSync } from 'node:sqlite'
import { test as base, expect } from '@playwright/test'
import { launchIsolatedElectron, supervisedHubRoot } from '../fixtures/electron'

/**
 * A clean quit writes its last diagnostics events before the diagnostics DB closes.
 *
 * `will-quit` used to call the async `stopDiagnostics()` unawaited and close the
 * diagnostics worker on the next line, so the queue's tail — the
 * `app.will-quit.complete` canary among it — raced the close and was lost. It now
 * holds the quit for a bounded flush-then-close and quits again; this pins that the
 * held quit still ends the process cleanly, with the canary and the sentinel down.
 *
 * Isolated instance: the spec quits the app, which the shared worker app must survive.
 */
base.describe('quit flushes diagnostics', () => {
  base('app.will-quit.complete lands and the process exits cleanly', async () => {
    base.setTimeout(120_000)
    const launched = await launchIsolatedElectron({ name: 'quit-flushes-diagnostics' })
    let exited = false
    try {
      const userData = await launched.app.evaluate(({ app }) => app.getPath('userData'))
      const sentinel = path.join(userData, '.clean-shutdown')
      // Boot removes the previous session's sentinel, so presence below proves THIS quit wrote it.
      expect(fs.existsSync(sentinel)).toBe(false)

      const proc = launched.app.process()
      const exitCode = new Promise<number | null>((resolve) => proc.once('exit', resolve))
      await launched.app.evaluate(({ app }) => app.quit()).catch(() => {
        // The evaluate can lose its channel as the process goes down.
      })
      const code = await Promise.race([
        exitCode,
        new Promise<'hung'>((r) => setTimeout(() => r('hung'), 30_000))
      ])
      exited = code !== 'hung'
      expect(code).toBe(0)

      expect(fs.existsSync(sentinel)).toBe(true)

      const dbPath = path.join(
        supervisedHubRoot(launched.userDataDir),
        'slayzone.dev.diagnostics.sqlite'
      )
      expect(fs.existsSync(dbPath)).toBe(true)
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const rows = db
          .prepare(`SELECT COUNT(*) AS c FROM diagnostics_events WHERE event = 'app.will-quit.complete'`)
          .get() as unknown as { c: number }
        expect(rows.c).toBe(1)
      } finally {
        db.close()
      }
    } finally {
      if (!exited) await launched.close()
    }
  })
})
