import type { Page } from '@playwright/test'
import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  getMainSessionId,
  openTaskTerminal,
  readFullBuffer,
  runCommand,
  waitForPtySession
} from '../fixtures/terminal'

// Issue #103: Option+2 sent ESC 2 instead of @ on Swedish/German/Nordic layouts —
// xterm was built with a hardcoded `macOptionIsMeta: true`. The
// `terminal_option_as_meta` setting now decides per keystroke, inside the xterm
// key handler, so a change reaches live AND cached/reattached terminals.
//
// Playwright's keyboard speaks only the US layout, so the keystroke is the one
// Chromium reports for Option+2 on Swedish - Pro: key '@', code Digit2. Under
// `cat`, the tty echoes what the pty received: '@', or ESC 2 shown as '^[2'.
const META_ECHO = '^[2'

const panelBtn = (page: Page, label: string) =>
  page
    .locator('.bg-surface-2.rounded-lg:visible')
    .filter({ has: page.locator('button:has-text("Agent")') })
    .locator(`button:has-text("${label}")`)

/**
 * Option+2 on Swedish - Pro, into the on-screen xterm's input textarea, through
 * xterm's real keydown → keypress path. Found via the DOM, not the
 * `__slayzone_terminalLinks` handle: that one is dropped on unmount and not
 * re-registered when a cached terminal is reattached.
 */
function pressSwedishOption2(page: Page, side: 'left' | 'right') {
  return page.evaluate(
    (altCode) => {
      const xterm = [...document.querySelectorAll<HTMLElement>('.xterm')].find(
        (el) => el.offsetParent !== null
      )
      const ta = xterm!.querySelector<HTMLTextAreaElement>('textarea.xterm-helper-textarea')!
      const fire = (type: string, init: KeyboardEventInit) => {
        const ev = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
        ta.dispatchEvent(ev)
        return ev
      }
      fire('keydown', { key: 'Alt', code: altCode, keyCode: 18, altKey: true })
      const down = fire('keydown', { key: '@', code: 'Digit2', keyCode: 50, altKey: true })
      // A browser fires keypress only for a keydown nobody cancelled.
      if (!down.defaultPrevented)
        fire('keypress', { key: '@', code: 'Digit2', charCode: 64, keyCode: 64, altKey: true })
      fire('keyup', { key: '@', code: 'Digit2', keyCode: 50, altKey: true })
      fire('keyup', { key: 'Alt', code: altCode, keyCode: 18, altKey: false })
    },
    side === 'left' ? 'AltLeft' : 'AltRight'
  )
}

async function setOptionAsMeta(page: Page, value: string): Promise<void> {
  await seed(page).setSetting('terminal_option_as_meta', value)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('sz:settings-changed')))
}

test.describe('macOS Option as Meta (issue #103)', () => {
  test.skip(process.platform !== 'darwin', 'Option-as-Meta is macOS-only')

  let taskId: string
  let attempt = 0

  /**
   * What one Option+2 sent, isolated behind a fresh marker line. Retried by the
   * callers' poll: a setting change lands on the renderer asynchronously.
   *
   * Returns 'none' when nothing arrived instead of throwing: `expect.poll` does
   * not retry a callback that throws, so a throw here ended the callers' 15s poll
   * after 5s (full suite under load, 2026-10-29).
   */
  async function typedBy(page: Page, side: 'left' | 'right'): Promise<'meta' | 'char' | 'none'> {
    const sessionId = getMainSessionId(taskId)
    const marker = `OPT${++attempt}_${Date.now()}`
    await runCommand(page, sessionId, marker)
    // Twice: the tty's echo of the line, then `cat`'s copy of it. Pressing after
    // only the echo lets a slow `cat` print its copy AFTER the key's echo, and the
    // segment below — read from the last copy on — then never shows the key.
    await expect
      .poll(async () => (await readFullBuffer(page, sessionId)).split(marker).length - 1, {
        message: '`cat` printed the marker line'
      })
      .toBeGreaterThanOrEqual(2)
    await pressSwedishOption2(page, side)
    let seg = ''
    await expect
      .poll(
        async () => {
          const buf = await readFullBuffer(page, sessionId)
          seg = buf.slice(buf.lastIndexOf(marker) + marker.length)
          return seg.includes('@') || seg.includes(META_ECHO)
        },
        { timeout: 4_000 }
      )
      .toBe(true)
      .catch(() => {})
    if (seg.includes(META_ECHO)) return 'meta'
    return seg.includes('@') ? 'char' : 'none'
  }

  const poll = { timeout: 15_000, intervals: [250, 500, 1_000] }

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Option Meta',
      color: '#0ea5e9',
      path: TEST_PROJECT_PATH
    })
    const t = await s.createTask({
      projectId: p.id,
      title: 'Option meta task',
      status: 'in_progress',
      terminalMode: 'terminal'
    })
    taskId = t.id
    await setOptionAsMeta(mainWindow, '')
    await s.refreshData()

    await openTaskTerminal(mainWindow, { projectAbbrev: 'OP', taskTitle: 'Option meta task' })
    const sessionId = getMainSessionId(taskId)
    await waitForPtySession(mainWindow, sessionId)
    // `cat` keeps the tty canonical, so the echo shows the exact bytes received.
    await runCommand(mainWindow, sessionId, 'cat')
  })

  test('default (auto): Option+2 on Swedish types @', async ({ mainWindow }) => {
    await expect.poll(() => typedBy(mainWindow, 'left'), poll).toBe('char')
  })

  test('both: Option+2 sends ESC 2; the change reaches the live terminal', async ({
    mainWindow
  }) => {
    await setOptionAsMeta(mainWindow, 'both')
    await expect.poll(() => typedBy(mainWindow, 'left'), poll).toBe('meta')
  })

  test('left: only the left Option key is Meta', async ({ mainWindow }) => {
    await setOptionAsMeta(mainWindow, 'left')
    // Left first: right types '@' before the change lands too, so only left proves it.
    await expect.poll(() => typedBy(mainWindow, 'left'), poll).toBe('meta')
    await expect.poll(() => typedBy(mainWindow, 'right'), poll).toBe('char')
  })

  test('a terminal reattached from the cache follows a change made while detached', async ({
    mainWindow
  }) => {
    await setOptionAsMeta(mainWindow, 'none')
    await expect.poll(() => typedBy(mainWindow, 'left'), poll).toBe('char')

    await panelBtn(mainWindow, 'Agent').click()
    await expect(panelBtn(mainWindow, 'Agent')).not.toHaveClass(/(?:^|\s)bg-surface-3(?:\s|$)/)
    await setOptionAsMeta(mainWindow, 'both')
    await panelBtn(mainWindow, 'Agent').click()
    await expect(panelBtn(mainWindow, 'Agent')).toHaveClass(/(?:^|\s)bg-surface-3(?:\s|$)/)

    await expect.poll(() => typedBy(mainWindow, 'left'), poll).toBe('meta')
  })
})
