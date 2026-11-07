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
      await launched.app
        .evaluate(({ app }) => app.quit())
        .catch(() => {
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
        // THIS process's canary: a retried launch boots (and cleanly quits) earlier
        // attempts into the same userdata dir, each with its own canary.
        const rows = db
          .prepare(
            `SELECT COUNT(*) AS c FROM diagnostics_events
             WHERE event = 'app.will-quit.complete'
               AND ts_ms >= (SELECT MAX(ts_ms) FROM diagnostics_events
                             WHERE event = 'app.boot.start'
                               AND json_extract(payload_json, '$.pid') = ?)`
          )
          .get(proc.pid ?? -1) as unknown as { c: number }
        expect(rows.c).toBe(1)
      } finally {
        db.close()
      }
    } finally {
      if (!exited) await launched.close()
    }
  })

  /**
   * A page that vetoes `beforeunload` cannot hold the app open.
   *
   * Electron shows no "leave page?" dialog: a veto silently cancels the window's
   * close, and a cancelled close cancels the whole quit — `will-quit` never fires
   * and only the 15s watchdog ends the process (exit 1, next boot reports an unclean
   * shutdown). The Convex client in every app window vetoed this way whenever one of
   * its requests had no reply yet. Packaged pilot 2026-11-03: every normal quit hit
   * the watchdog with the drain already complete.
   */
  base('a beforeunload veto in the main window does not cancel the quit', async () => {
    base.setTimeout(120_000)
    const launched = await launchIsolatedElectron({ name: 'quit-beforeunload-veto' })
    let exited = false
    try {
      const userData = await launched.app.evaluate(({ app }) => app.getPath('userData'))
      const sentinel = path.join(userData, '.clean-shutdown')
      expect(fs.existsSync(sentinel)).toBe(false)

      // Leave the veto to the app: a listener stops Playwright auto-dismissing the
      // beforeunload "dialog" over CDP, which the real app never has.
      launched.page.on('dialog', () => {})
      // What the Convex client does while a request is unanswered.
      await launched.page.evaluate(() => {
        window.addEventListener('beforeunload', (event) => {
          event.preventDefault()
          event.returnValue = ''
        })
      })

      const proc = launched.app.process()
      const exitCode = new Promise<number | null>((resolve) => proc.once('exit', resolve))
      await launched.app
        .evaluate(({ app }) => app.quit())
        .catch(() => {
          // The evaluate can lose its channel as the process goes down.
        })
      // The quit watchdog (vetoed quit) ends the app with exit code 1 and skips
      // will-quit, which writes the clean-shutdown sentinel: code 0 plus the sentinel
      // prove the quit went through. (A 10 s race stood in for that, and a loaded
      // machine's clean quit outran it.)
      const code = await exitCode
      exited = true
      expect(code).toBe(0)
      expect(fs.existsSync(sentinel)).toBe(true)
    } finally {
      if (!exited) await launched.close()
    }
  })
})
