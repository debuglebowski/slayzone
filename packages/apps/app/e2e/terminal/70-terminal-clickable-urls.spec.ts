/**
 * Terminal clickable URLs — verifies that URLs in terminal output are detected
 * and that clicking them triggers the correct action (browser panel or external).
 *
 * Test strategies:
 * 1. Programmatic: provideLinks → activate (tests our link provider + callback logic)
 * 2. Playwright mouse: native mouse API with held modifier keys (tests xterm Linkifier
 *    hover → click → activate chain through Chromium's input pipeline)
 */
import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  getMainSessionId,
  openTaskTerminal,
  runCommand,
  waitForBufferContains,
  waitForPtySession
} from '../fixtures/terminal'

test.describe('Terminal clickable URLs', () => {
  let projectAbbrev: string
  let taskId: string
  let sessionId: string

  test.beforeAll(async ({ electronApp, mainWindow }) => {
    await resetApp(mainWindow)

    // Mock shell.openExternal to capture calls
    const patchResult = await electronApp.evaluate(({ shell }) => {
      const g = globalThis as Record<string, unknown>
      g.__urlTestCalls = [] as string[]
      g.__urlTestOriginal = shell.openExternal.bind(shell)
      try {
        Object.defineProperty(shell, 'openExternal', {
          configurable: true,
          writable: true,
          value: async (url: string) => {
            ;(g.__urlTestCalls as string[]).push(url)
          }
        })
        return { ok: true as const, error: null }
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
      }
    })
    expect(patchResult.ok, patchResult.error ?? 'Failed to mock openExternal').toBe(true)

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'UrlClick', color: '#06b6d4', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    const t = await s.createTask({
      projectId: p.id,
      title: 'URL click test',
      status: 'in_progress'
    })
    taskId = t.id
    sessionId = getMainSessionId(taskId)

    await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.update.mutate({ id, terminalMode: 'terminal' }),
      taskId
    )
    await s.refreshData()
  })

  test.afterAll(async ({ electronApp }) => {
    await electronApp.evaluate(({ shell }) => {
      const g = globalThis as Record<string, unknown>
      if (g.__urlTestOriginal) {
        Object.defineProperty(shell, 'openExternal', {
          configurable: true,
          writable: true,
          value: g.__urlTestOriginal
        })
      }
      delete g.__urlTestCalls
      delete g.__urlTestOriginal
    })
  })

  /** Wait for URL to appear in xterm's frontend buffer */
  async function waitForUrlInFrontendBuffer(
    mainWindow: import('@playwright/test').Page,
    sid: string,
    needle: string
  ) {
    await expect
      .poll(
        async () => {
          return mainWindow.evaluate(
            ({ sessionId, needle }) => {
              const w = window as unknown as Record<string, unknown>
              const links = w.__slayzone_terminalLinks as
                | Record<
                    string,
                    {
                      _terminal: {
                        buffer: {
                          active: {
                            length: number
                            getLine(
                              i: number
                            ): { translateToString(trimRight?: boolean): string } | undefined
                          }
                        }
                      }
                    }
                  >
                | undefined
              const provider = links?.[sessionId]
              if (!provider) return false
              const buf = provider._terminal.buffer.active
              for (let i = 0; i < buf.length; i++) {
                const line = buf.getLine(i)
                if (line?.translateToString(true).includes(needle)) return true
              }
              return false
            },
            { sessionId, needle }
          )
        },
        { timeout: 10_000, message: 'URL never appeared in xterm frontend buffer' }
      )
      .toBe(true)
  }

  /** Clear the mock call log */
  async function clearExternalCalls(electronApp: import('playwright').ElectronApplication) {
    await electronApp.evaluate(() => {
      ;(globalThis as Record<string, unknown>).__urlTestCalls = []
    })
  }

  /** Find & activate a link programmatically via provideLinks */
  async function activateLinkProgrammatically(
    mainWindow: import('@playwright/test').Page,
    sid: string,
    url: string,
    opts: { metaKey: boolean; shiftKey: boolean }
  ) {
    return mainWindow.evaluate(
      async ({ sessionId, url, metaKey, shiftKey }) => {
        const w = window as unknown as Record<string, unknown>
        const links = w.__slayzone_terminalLinks as
          | Record<
              string,
              {
                _terminal: { buffer: { active: { length: number } } }
                provideLinks(
                  y: number,
                  cb: (
                    links:
                      | Array<{ text: string; activate: (e: MouseEvent, text: string) => void }>
                      | undefined
                  ) => void
                ): void
              }
            >
          | undefined

        const provider = links?.[sessionId]
        if (!provider) return { found: false, error: 'no link provider for session' }

        const bufferLength = provider._terminal.buffer.active.length
        for (let line = 1; line <= bufferLength; line++) {
          const found = await new Promise<boolean>((resolve) => {
            provider.provideLinks(line, (result) => {
              const match = result?.find((l) => l.text === url)
              if (match) {
                match.activate(new MouseEvent('click', { metaKey, shiftKey }), match.text)
                resolve(true)
              } else {
                resolve(false)
              }
            })
          })
          if (found) return { found: true, error: null }
        }
        return { found: false, error: `URL not found in ${bufferLength} buffer lines` }
      },
      { sessionId, url, ...opts }
    )
  }

  /** Get pixel coords of URL in terminal for mouse interaction */
  async function getUrlPixelCoords(
    mainWindow: import('@playwright/test').Page,
    sid: string,
    url: string
  ) {
    return mainWindow.evaluate(
      ({ sessionId, url }) => {
        const w = window as unknown as Record<string, unknown>
        const links = w.__slayzone_terminalLinks as
          | Record<
              string,
              {
                _terminal: {
                  element: HTMLElement
                  buffer: { active: { length: number } }
                  _core: {
                    _charSizeService: { width: number; height: number }
                    _bufferService: { buffer: { ydisp: number } }
                  }
                }
                provideLinks(
                  y: number,
                  cb: (
                    links:
                      | Array<{
                          text: string
                          range: { start: { x: number; y: number }; end: { x: number; y: number } }
                        }>
                      | undefined
                  ) => void
                ): void
              }
            >
          | undefined

        const provider = links?.[sessionId]
        if (!provider) return null

        const terminal = provider._terminal
        const charWidth = terminal._core._charSizeService.width
        const charHeight = terminal._core._charSizeService.height
        const ydisp = terminal._core._bufferService.buffer.ydisp
        const matches: Array<{
          text: string
          range: { start: { x: number; y: number }; end: { x: number; y: number } }
        }> = []

        for (let line = 1; line <= terminal.buffer.active.length; line++) {
          provider.provideLinks(line, (result) => {
            for (const link of result ?? []) {
              if (link.text === url) matches.push(link)
            }
          })
        }
        if (matches.length === 0) return null

        const match = matches[matches.length - 1]
        const screenEl = terminal.element?.querySelector('.xterm-screen')
        if (!screenEl) return null
        const rect = screenEl.getBoundingClientRect()
        const targetLine = match.range.start.y - 1
        const viewportLine = targetLine - ydisp
        const spanWidth = Math.max(1, match.range.end.x - match.range.start.x)
        const targetCol = match.range.start.x - 1 + Math.floor(spanWidth / 2)
        return {
          x: rect.left + (targetCol + 0.5) * charWidth,
          y: rect.top + (viewportLine + 0.5) * charHeight
        }
      },
      { sessionId, url }
    )
  }

  test('Cmd+Shift+Click opens URL externally (programmatic)', async ({
    electronApp,
    mainWindow
  }) => {
    const testUrl = `https://example.com/test-${Date.now()}`

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'URL click test' })
    await waitForPtySession(mainWindow, sessionId)
    await runCommand(mainWindow, sessionId, `echo "${testUrl}"`)
    await waitForBufferContains(mainWindow, sessionId, testUrl)
    await waitForUrlInFrontendBuffer(mainWindow, sessionId, 'example.com')

    const result = await activateLinkProgrammatically(mainWindow, sessionId, testUrl, {
      metaKey: true,
      shiftKey: true
    })
    expect(result.found, result.error ?? 'Link not found').toBe(true)

    const calls = await electronApp.evaluate(() => {
      return (globalThis as Record<string, unknown>).__urlTestCalls as string[]
    })
    expect(calls).toContain(testUrl)
  })

  test('Cmd+Shift+Click opens URL externally (Playwright mouse)', async ({
    electronApp,
    mainWindow
  }) => {
    await clearExternalCalls(electronApp)
    const testUrl = `https://example.com/playwright-${Date.now()}`

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'URL click test' })
    await waitForPtySession(mainWindow, sessionId)
    await runCommand(mainWindow, sessionId, `echo "${testUrl}"`)
    await waitForBufferContains(mainWindow, sessionId, testUrl)
    await waitForUrlInFrontendBuffer(mainWindow, sessionId, testUrl)

    const coords = await getUrlPixelCoords(mainWindow, sessionId, testUrl)
    expect(coords, 'Could not find URL coordinates').not.toBeNull()

    // Hold modifier keys BEFORE clicking — page.mouse.click({ modifiers }) doesn't
    // propagate meta/shift into MouseEvent properties in Electron.
    await mainWindow.mouse.move(coords!.x, coords!.y)
    await mainWindow.waitForTimeout(100)
    await mainWindow.keyboard.down('Meta')
    await mainWindow.keyboard.down('Shift')
    await mainWindow.mouse.click(coords!.x, coords!.y)
    await mainWindow.keyboard.up('Shift')
    await mainWindow.keyboard.up('Meta')
    await mainWindow.waitForTimeout(200)

    const calls = await electronApp.evaluate(() => {
      return (globalThis as Record<string, unknown>).__urlTestCalls as string[]
    })
    expect(calls).toContain(testUrl)
  })

  test('OSC 8 hyperlink opens externally on Cmd+Shift+Click (Playwright mouse)', async ({
    electronApp,
    mainWindow
  }) => {
    await clearExternalCalls(electronApp)
    const testUrl = `https://example.com/osc8-${Date.now()}`
    const linkText = 'click-here-osc8'

    // Write an OSC 8 hyperlink: visible text is "click-here-osc8", URL is hidden in escape sequence
    await runCommand(
      mainWindow,
      sessionId,
      `printf '\\e]8;;${testUrl}\\e\\\\${linkText}\\e]8;;\\e\\\\'`
    )
    await waitForBufferContains(mainWindow, sessionId, linkText)
    await waitForUrlInFrontendBuffer(mainWindow, sessionId, linkText)

    // getUrlPixelCoords finds the first occurrence — which is the command prompt line
    // (literal text, not an OSC 8 link). The actual OSC 8 output is on a LATER line.
    // Search for the LAST occurrence of the link text to find the output line.
    const coords = await mainWindow.evaluate(
      ({ sessionId, linkText }) => {
        const w = window as unknown as Record<string, unknown>
        const links = w.__slayzone_terminalLinks as
          | Record<
              string,
              {
                _terminal: {
                  element: HTMLElement
                  buffer: {
                    active: {
                      length: number
                      getLine(
                        i: number
                      ): { translateToString(trimRight?: boolean): string } | undefined
                    }
                  }
                  _core: {
                    _charSizeService: { width: number; height: number }
                    _bufferService: { buffer: { ydisp: number } }
                  }
                }
              }
            >
          | undefined

        const terminal = links?.[sessionId]?._terminal
        if (!terminal) return null

        const buf = terminal.buffer.active
        const charWidth = terminal._core._charSizeService.width
        const charHeight = terminal._core._charSizeService.height
        const ydisp = terminal._core._bufferService.buffer.ydisp

        // Find the LAST line containing the link text (the output, not the command prompt)
        let lastLine = -1,
          lastCol = -1
        for (let i = 0; i < buf.length; i++) {
          const text = buf.getLine(i)?.translateToString(true) ?? ''
          const idx = text.indexOf(linkText)
          if (idx !== -1) {
            lastLine = i
            lastCol = idx
          }
        }
        if (lastLine === -1) return null

        const screenEl = terminal.element?.querySelector('.xterm-screen')
        if (!screenEl) return null
        const rect = screenEl.getBoundingClientRect()
        const viewportLine = lastLine - ydisp
        const targetCol = lastCol + Math.floor(linkText.length / 2)
        return {
          x: rect.left + (targetCol + 0.5) * charWidth,
          y: rect.top + (viewportLine + 0.5) * charHeight,
          line: lastLine
        }
      },
      { sessionId, linkText }
    )
    expect(coords, 'Could not find OSC 8 link output coordinates').not.toBeNull()

    // Cmd+Shift+Click — OSC 8 links should open externally
    await mainWindow.mouse.move(coords!.x, coords!.y)
    await mainWindow.waitForTimeout(100)
    await mainWindow.keyboard.down('Meta')
    await mainWindow.keyboard.down('Shift')
    await mainWindow.mouse.click(coords!.x, coords!.y)
    await mainWindow.keyboard.up('Shift')
    await mainWindow.keyboard.up('Meta')
    await mainWindow.waitForTimeout(200)

    const calls = await electronApp.evaluate(() => {
      return (globalThis as Record<string, unknown>).__urlTestCalls as string[]
    })
    expect(
      calls,
      `OSC 8 Cmd+Shift+Click did not trigger openExternal (line ${coords!.line})`
    ).toContain(testUrl)
  })

  // This test opens a browser panel — keep it LAST to avoid breaking subsequent tests
  test('Cmd+Click opens URL in browser panel (programmatic)', async ({ mainWindow }) => {
    const testUrl = `https://example.com/internal-${Date.now()}`

    await runCommand(mainWindow, sessionId, `echo "${testUrl}"`)
    await waitForBufferContains(mainWindow, sessionId, testUrl)
    await waitForUrlInFrontendBuffer(mainWindow, sessionId, testUrl)

    const result = await activateLinkProgrammatically(mainWindow, sessionId, testUrl, {
      metaKey: true,
      shiftKey: false
    })
    expect(result.found, result.error ?? 'Link not found').toBe(true)

    await expect(mainWindow.locator('[data-browser-panel]:visible').first()).toBeVisible({
      timeout: 5_000
    })
  })
})
