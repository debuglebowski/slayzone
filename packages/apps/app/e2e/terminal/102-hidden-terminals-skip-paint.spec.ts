/**
 * Hidden task tabs stay mounted (that is what makes a switch fast), and their
 * terminals keep receiving PTY output. They must keep PARSING it — the buffer,
 * modes and title stay current — but must not PAINT it: nobody can see a hidden
 * pane, and a WebGL frame per output chunk in every hidden terminal is main-thread
 * work that lands on top of a tab switch.
 *
 * xterm pauses its renderer when its screen element stops intersecting the
 * viewport (IntersectionObserver). A hidden tab is `visibility: hidden`, which
 * still intersects, so without an explicit pause every hidden terminal painted
 * every output chunk. Revealing the tab must repaint the latest buffer at once.
 *
 * Counted via xterm's public `onRender` event — deterministic, unlike timing.
 */
import type { Page } from '@playwright/test'
import { test, expect, seed, openTaskById, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import { getMainSessionId, waitForPtySession } from '../fixtures/terminal'

interface XTermLike {
  rows: number
  cols: number
  buffer: {
    active: {
      length: number
      viewportY: number
      baseY: number
      getLine: (i: number) => { translateToString: (trim?: boolean) => string } | undefined
    }
  }
  onRender: (cb: () => void) => { dispose: () => void }
  scrollLines: (n: number) => void
}

type ProbeWindow = Window & {
  __slayzone_terminalLinks?: Record<string, { _terminal?: XTermLike }>
  __slayzone_tabStore: {
    getState: () => { openTask: (id: string) => void; openTaskInBackground: (id: string) => void }
  }
  __szPaints?: Record<string, number>
}

const HIDDEN = 4
// Monotonic counter so "the buffer moved on" is unambiguous.
const TICKER = `perl -e '$|=1; my $i=0; while(1){print "tick ".$i++."\\n"; select(undef,undef,undef,0.05)}'`

/** Highest tick number in a session's xterm buffer (parsed state, not pixels). */
async function lastTick(page: Page, sid: string): Promise<number> {
  return page.evaluate((id) => {
    const t = (window as unknown as ProbeWindow).__slayzone_terminalLinks?.[id]?._terminal
    if (!t) return -1
    const buf = t.buffer.active
    for (let i = buf.length - 1; i >= 0; i--) {
      const m = /tick (\d+)/.exec(buf.getLine(i)?.translateToString(true) ?? '')
      if (m) return Number(m[1])
    }
    return -1
  }, sid)
}

/** Start counting paints (xterm `onRender`) per session from zero. */
async function countPaints(page: Page, sids: string[]): Promise<void> {
  await page.evaluate((ids) => {
    const w = window as unknown as ProbeWindow & { __szPaintSubs?: Array<{ dispose: () => void }> }
    for (const d of w.__szPaintSubs ?? []) d.dispose()
    w.__szPaints = {}
    w.__szPaintSubs = ids.map((id) => {
      w.__szPaints![id] = 0
      return w.__slayzone_terminalLinks![id]._terminal!.onRender(() => {
        w.__szPaints![id]++
      })
    })
  }, sids)
}

const paints = (page: Page): Promise<Record<string, number>> =>
  page.evaluate(() => ({ ...(window as unknown as ProbeWindow).__szPaints }))

test.describe('hidden task terminals parse output but do not paint it', () => {
  let visibleId = ''
  const hiddenIds: string[] = []

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Hidden Paint',
      color: '#a855f7',
      path: TEST_PROJECT_PATH
    })
    for (let i = 0; i <= HIDDEN; i++) {
      const t = await s.createTask({
        projectId: p.id,
        title: `Hidden paint ${i}`,
        status: 'in_progress',
        terminalMode: 'terminal'
      })
      if (i === 0) visibleId = t.id
      else hiddenIds.push(t.id)
    }
    await s.refreshData()
  })

  test('hidden terminals stay current without painting, and repaint on reveal', async ({
    mainWindow
  }) => {
    test.setTimeout(120_000)
    const hiddenSids = hiddenIds.map(getMainSessionId)

    // Mount every terminal visibly once (a terminal first mounted hidden is also
    // covered, but a visible mount is the common path: a tab the user left).
    for (const id of [...hiddenIds, visibleId]) {
      await openTaskById(mainWindow, id)
      await waitForPtySession(mainWindow, getMainSessionId(id))
    }
    await expect
      .poll(
        () =>
          mainWindow.evaluate(
            (ids) =>
              ids.every(
                (id) =>
                  !!(window as unknown as ProbeWindow).__slayzone_terminalLinks?.[id]?._terminal
              ),
            hiddenSids
          ),
        { timeout: 20_000 }
      )
      .toBe(true)

    const sizeBefore = await mainWindow.evaluate(
      (ids) =>
        ids.map((id) => {
          const t = (window as unknown as ProbeWindow).__slayzone_terminalLinks![id]._terminal!
          return `${t.cols}x${t.rows}`
        }),
      hiddenSids
    )

    for (const sid of hiddenSids) {
      await mainWindow.evaluate(
        ({ id, cmd }) =>
          window.getTrpcVanillaClient().pty.write.mutate({ sessionId: id, data: `${cmd}\r` }),
        { id: sid, cmd: TICKER }
      )
    }
    // Every hidden buffer is advancing.
    for (const sid of hiddenSids) {
      await expect.poll(() => lastTick(mainWindow, sid), { timeout: 15_000 }).toBeGreaterThan(5)
    }

    await countPaints(mainWindow, hiddenSids)
    const before = await Promise.all(hiddenSids.map((sid) => lastTick(mainWindow, sid)))
    await mainWindow.waitForTimeout(2_000)
    const after = await Promise.all(hiddenSids.map((sid) => lastTick(mainWindow, sid)))
    const hiddenPaints = await paints(mainWindow)

    for (let i = 0; i < hiddenSids.length; i++) {
      // Parsing continued: ~40 ticks arrive in 2s; demand well over half.
      expect(after[i] - before[i], `buffer of hidden ${hiddenSids[i]} advanced`).toBeGreaterThan(15)
    }
    // Before the pause: one paint per output chunk in every hidden terminal (~20/s each).
    expect(hiddenPaints, 'hidden terminals painted while output flowed').toEqual(
      Object.fromEntries(hiddenSids.map((sid) => [sid, 0]))
    )
    // Hiding never resized a terminal (that would SIGWINCH the hidden process).
    const sizeAfter = await mainWindow.evaluate(
      (ids) =>
        ids.map((id) => {
          const t = (window as unknown as ProbeWindow).__slayzone_terminalLinks![id]._terminal!
          return `${t.cols}x${t.rows}`
        }),
      hiddenSids
    )
    expect(sizeAfter).toEqual(sizeBefore)

    // Reveal one: it repaints, and what it shows is the current buffer.
    const revealSid = hiddenSids[0]
    const tickAtReveal = await lastTick(mainWindow, revealSid)
    await mainWindow.evaluate(
      (id) => (window as unknown as ProbeWindow).__slayzone_tabStore.getState().openTask(id),
      hiddenIds[0]
    )
    await expect
      .poll(async () => (await paints(mainWindow))[revealSid], { timeout: 5_000 })
      .toBeGreaterThan(0)
    const viewportTick = await mainWindow.evaluate((id) => {
      const t = (window as unknown as ProbeWindow).__slayzone_terminalLinks![id]._terminal!
      const buf = t.buffer.active
      for (let i = t.rows - 1; i >= 0; i--) {
        const m = /tick (\d+)/.exec(buf.getLine(buf.viewportY + i)?.translateToString(true) ?? '')
        if (m) return Number(m[1])
      }
      return -1
    }, revealSid)
    expect(viewportTick).toBeGreaterThanOrEqual(tickAtReveal)
    // The still-hidden ones stay unpainted while the revealed one paints.
    const others = await paints(mainWindow)
    for (const sid of hiddenSids.slice(1)) expect(others[sid], sid).toBe(0)

    for (const sid of hiddenSids) {
      await mainWindow.evaluate(
        (id) => window.getTrpcVanillaClient().pty.write.mutate({ sessionId: id, data: '\x03' }),
        sid
      )
    }
  })

  test('a hidden terminal keeps its scroll position', async ({ mainWindow }) => {
    test.setTimeout(60_000)
    const sid = getMainSessionId(hiddenIds[1])
    await openTaskById(mainWindow, hiddenIds[1])
    // Plenty of scrollback (after stopping anything still running), then scroll up.
    await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().pty.write.mutate({ sessionId: id, data: '\x03' }),
      sid
    )
    await mainWindow.evaluate(
      (id) =>
        window.getTrpcVanillaClient().pty.write.mutate({
          sessionId: id,
          data: `perl -e 'print "line $_\\n" for 1..300'\r`
        }),
      sid
    )
    await expect
      .poll(
        () =>
          mainWindow.evaluate((id) => {
            const t = (window as unknown as ProbeWindow).__slayzone_terminalLinks![id]._terminal!
            return t.buffer.active.baseY
          }, sid),
        { timeout: 10_000 }
      )
      .toBeGreaterThan(50)
    const scrolledTo = await mainWindow.evaluate((id) => {
      const t = (window as unknown as ProbeWindow).__slayzone_terminalLinks![id]._terminal!
      t.scrollLines(-20)
      return t.buffer.active.viewportY
    }, sid)

    await openTaskById(mainWindow, visibleId)
    await mainWindow.waitForTimeout(500)
    await openTaskById(mainWindow, hiddenIds[1])
    await mainWindow.waitForTimeout(300)
    const back = await mainWindow.evaluate((id) => {
      const t = (window as unknown as ProbeWindow).__slayzone_terminalLinks![id]._terminal!
      return t.buffer.active.viewportY
    }, sid)
    expect(back).toBe(scrolledTo)
  })
})
