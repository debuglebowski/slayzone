/**
 * The ONE way to bring a window to the foreground.
 *
 * Under Playwright the app deliberately never presents its main window: the
 * splash is skipped (`createWindow`) and `tryShowMainWindow` gates its `show()`
 * behind `!isPlaywright`, so the window is created `show: false` and stays
 * hidden while Playwright drives it over CDP. Five call sites then open-coded
 * the same `restore()/show()/focus()` triplet WITHOUT that gate, so any spec
 * reaching one of them popped the window over the developer's screen and took
 * their keyboard focus mid-suite.
 *
 * That is not a cosmetic annoyance: the e2e `electronApp`/`mainWindow` fixtures
 * are WORKER-scoped, so one raise leaves the window visible and focused for
 * every remaining spec in that worker — a single `slay tasks open` in
 * e2e/terminal/34-cli-pty-start.spec.ts foregrounds the whole terminal group.
 *
 * Deliberately electron-free: it takes the window as a structural type rather
 * than importing `BrowserWindow`, so the unit test runs under plain `tsx` with
 * no electron mock, and callers keep their own fallback policy (some prefer
 * `mainWindow`, the REST deps only have `getAllWindows()[0]`).
 */

/** The slice of `BrowserWindow` presentation needs. */
export interface PresentableWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
}

export type PresentOutcome =
  /** Window was restored (if minimized), shown and focused. */
  | 'presented'
  /** PLAYWRIGHT=1 — the hidden-window invariant held, nothing was touched. */
  | 'skipped-under-test'
  /** No window to present (null/undefined, or already destroyed). */
  | 'no-window'

/**
 * Decision half, with the environment injected — mirrors `raiseFdLimitWith`.
 * Returns the outcome so a caller (and the test) can tell "we chose not to"
 * apart from "there was nothing to show".
 */
export function presentWindowWith(
  win: PresentableWindow | null | undefined,
  isPlaywright: boolean
): PresentOutcome {
  if (isPlaywright) return 'skipped-under-test'
  if (!win || win.isDestroyed()) return 'no-window'
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  return 'presented'
}

/**
 * Bring `win` to the foreground. No-ops under Playwright.
 *
 * Callers pass the window they mean — there is no implicit fallback, because
 * `getAllWindows()[0]` is the SPLASH during boot and raising that instead of
 * the main window would be a silent misfire.
 */
export function presentWindow(win: PresentableWindow | null | undefined): PresentOutcome {
  return presentWindowWith(win, process.env.PLAYWRIGHT === '1')
}
