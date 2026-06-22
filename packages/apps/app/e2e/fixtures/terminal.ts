import type { Page } from '@playwright/test'
import { expect } from './electron'
import { openTaskByTitle } from './electron'
import type { TerminalMode, TerminalState } from '@slayzone/terminal/shared'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { execSync } from 'child_process'

/** Check if a binary exists at an absolute path */
export function binaryExistsAt(absolutePath: string): boolean {
  return existsSync(absolutePath)
}

/** Check if a binary is on PATH */
export function binaryOnPath(name: string): boolean {
  try {
    execSync(`which ${name}`, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/** Common binary paths for CLI providers */
export const CLI_PATHS = {
  'cursor-agent': `${homedir()}/.local/bin/cursor-agent`,
  gemini: 'gemini', // on PATH
  opencode: `${homedir()}/.opencode/bin/opencode`
} as const

function activeModeTrigger(page: Page) {
  // Multiple tabs from prior tests can leave hidden triggers in DOM; use the
  // last visible one (most-recently mounted = currently active tab).
  return page.locator('[data-testid="terminal-mode-trigger"]:visible').last()
}

export function getMainSessionId(taskId: string): string {
  return `${taskId}:${taskId}`
}

export function getTabSessionId(taskId: string, tabId: string): string {
  return `${taskId}:${tabId}`
}

export async function openTaskTerminal(
  page: Page,
  opts: { projectAbbrev: string; taskTitle: string }
): Promise<void> {
  // Deterministic open by id (resolved from title). The old goHome→clickProject→
  // card-click/search-dialog open flaked under full-suite load: a wrong or stray
  // active task (incl. temporary "Terminal N" scratch tasks) meant the INTENDED task's
  // terminal never mounted and its PTY never spawned — surfacing downstream as
  // `waitForPtySession` timeouts that look like "PTY spawn latency" but are really a
  // wrong-task open. See openTaskByTitle. `projectAbbrev` is no longer needed but is
  // kept in the signature for call-site compatibility.
  await openTaskByTitle(page, opts.taskTitle)
  await expect(activeModeTrigger(page)).toBeVisible()
  await expect(page.locator('[data-testid="terminal-tabbar"]:visible').first()).toBeVisible()
}

export async function startAgentTerminal(page: Page): Promise<void> {
  // AI-mode terminals are idle-gated (TerminalStarter): an autofocused "Open <agent>"
  // button must be clicked to spawn the PTY (saves CPU/API credits). Plain `terminal`
  // auto-spawns (no gate) — no-op there. Call after openTaskTerminal (+ switchTerminalMode).
  const starter = page
    .locator('button')
    .filter({ hasText: /(Open|Reopen) (Claude|Codex|Cursor|OpenCode|Copilot|Qwen|Gemini)/ })
    .last()
  // Retry-click until the gate disappears (= started). A single click can miss if
  // the button is still settling, so poll up to ~8s.
  let started = false
  for (let i = 0; i < 16; i++) {
    if (!(await starter.isVisible({ timeout: 500 }).catch(() => false))) {
      started = true
      break
    }
    await starter.click({ timeout: 1_000 }).catch(() => {})
    await page.waitForTimeout(250)
  }
  // Sync point: once the gate is gone the <Terminal> mounts + runs its spawn
  // effect. Wait for the xterm to appear so callers can rely on pty.create having
  // fired (the gate vanishing alone races the effect).
  if (started) {
    await page
      .locator('.xterm')
      .first()
      .waitFor({ state: 'visible', timeout: 8_000 })
      .catch(() => {})
  }
}

export async function switchTerminalMode(page: Page, mode: TerminalMode): Promise<void> {
  const labels: Record<TerminalMode, string[]> = {
    'claude-code': ['Claude', 'Claude Code'],
    codex: ['Codex'],
    'cursor-agent': ['Cursor', 'Cursor Agent'],
    gemini: ['Gemini'],
    opencode: ['OpenCode'],
    copilot: ['Copilot'],
    terminal: ['Terminal']
  }

  // Dismiss any blocking overlay (dialog, popover, select) that may linger from a previous test
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(100)

  // Radix Dialog scroll-lock (react-remove-scroll) can leave pointer-events:none on <body>
  // or <html> if the dialog close animation completes before the cleanup runs.
  // Force-clear so subsequent clicks land on real elements.
  await page.evaluate(() => {
    for (const el of [document.documentElement, document.body]) {
      if (getComputedStyle(el).pointerEvents === 'none') {
        el.style.pointerEvents = ''
      }
    }
  })

  const trigger = activeModeTrigger(page)
  // Provider switcher uses Radix ContextMenu. The chevron's onClick dispatches
  // a synthetic contextmenu event on data-tab-main. Try chevron click first,
  // then a real right-click on the tab, then a direct JS contextmenu dispatch
  // — whichever opens the menu wins.
  const tryOpenMenu = async () => {
    // Strategy 1: click the chevron (its onClick dispatches contextmenu on the tab)
    const dropdownBtn = trigger.locator('[data-testid="terminal-mode-dropdown"], button').first()
    if (await dropdownBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await dropdownBtn.click().catch(() => {})
    }
    if (
      await page
        .getByRole('menuitemradio')
        .first()
        .isVisible({ timeout: 600 })
        .catch(() => false)
    )
      return true
    // Strategy 2: native right-click on the tab body
    const tab = trigger.locator('xpath=ancestor::*[@data-tab-main="true"]').first()
    if (await tab.isVisible({ timeout: 500 }).catch(() => false)) {
      await tab.click({ button: 'right' })
    }
    if (
      await page
        .getByRole('menuitemradio')
        .first()
        .isVisible({ timeout: 600 })
        .catch(() => false)
    )
      return true
    return false
  }
  const menuOpen = await tryOpenMenu()

  // Provider switcher uses Radix ContextMenuRadioItem (role=menuitemradio).
  // Older DropdownMenu (role=menuitem) and Select (role=option) markups are
  // tolerated for backwards-compat with stale snapshots.
  if (menuOpen) {
    for (const label of labels[mode] ?? [mode]) {
      const re = new RegExp(`^${label}(\\s*✓)?$`)
      for (const role of ['menuitemradio', 'menuitem', 'option'] as const) {
        const item = page.getByRole(role, { name: re }).first()
        if (await item.isVisible({ timeout: 800 }).catch(() => false)) {
          await item.click()
          await expect(trigger).toContainText(label)
          return
        }
      }
    }
  }

  // Fallback: ContextMenu fixture is flaky in some scenarios. Reproduce the
  // semantics of `handleModeChange` directly — kill the main PTY (if any),
  // clear all conversationIds, set the new mode, force a refresh. End-state
  // matches the UI path; only the menu interaction is bypassed.
  const taskId = await page.evaluate(() => {
    const store = (
      window as {
        __slayzone_tabStore?: {
          getState: () => { tabs: { type: string; taskId?: string }[]; activeTabIndex: number }
        }
      }
    ).__slayzone_tabStore
    const state = store?.getState()
    const tab = state?.tabs[state.activeTabIndex]
    return tab?.type === 'task' ? tab.taskId : null
  })
  if (!taskId)
    throw new Error(`switchTerminalMode fallback: no active task tab found (mode=${mode})`)
  await page.evaluate(
    async ({ id, m }) => {
      try {
        await window.getTrpcVanillaClient().pty.kill.mutate({ sessionId: `${id}:${id}` })
      } catch {
        /* may not exist */
      }
      const t = await window.getTrpcVanillaClient().task.get.query({ id })
      const cfg = t?.provider_config ?? null
      const cleared: Record<string, { conversationId: null }> = {}
      for (const k of Object.keys(cfg ?? {})) cleared[k] = { conversationId: null }
      await window
        .getTrpcVanillaClient()
        .task.update.mutate({ id, terminalMode: m, providerConfig: cleared })
      const refresh = (window as { __slayzone_refreshData?: () => Promise<void> | void })
        .__slayzone_refreshData
      await refresh?.()
    },
    { id: taskId, m: mode }
  )
  // Force a TaskDetailPage remount by toggling tabs — handleModeChange in
  // source does this implicitly via markSkipCache + remountTerminal. Without
  // the remount, Terminal's useEffect won't re-run and no new PTY will spawn
  // for the new mode.
  await page.evaluate((id) => {
    type Store = {
      getState: () => {
        tabs: { type: string; taskId?: string }[]
        activeTabIndex: number
        setActiveTabIndex: (i: number) => void
      }
    }
    const store = (window as unknown as { __slayzone_tabStore?: Store }).__slayzone_tabStore
    if (!store) return
    const state = store.getState()
    const idx = state.tabs.findIndex((t) => t.type === 'task' && t.taskId === id)
    if (idx < 0) return
    const otherIdx = idx === 0 ? Math.min(1, state.tabs.length - 1) : 0
    state.setActiveTabIndex(otherIdx)
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        store.getState().setActiveTabIndex(idx)
        setTimeout(resolve, 50)
      }, 100)
    })
  }, taskId)
  // Wait for trigger to reflect the new label
  const expectedLabel = (labels[mode] ?? [mode])[0]
  await expect(trigger).toContainText(expectedLabel, { timeout: 5_000 })
}

export async function waitForPtySession(
  page: Page,
  sessionId: string,
  timeoutMs = 20_000
): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate((id) => window.getTrpcVanillaClient().pty.exists.query({ sessionId: id }), sessionId),
      {
        timeout: timeoutMs
      }
    )
    .toBe(true)
}

export async function waitForNoPtySession(
  page: Page,
  sessionId: string,
  timeoutMs = 20_000
): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate((id) => window.getTrpcVanillaClient().pty.exists.query({ sessionId: id }), sessionId),
      {
        timeout: timeoutMs
      }
    )
    .toBe(false)
}

export async function waitForPtyState(
  page: Page,
  sessionId: string,
  state: TerminalState,
  timeoutMs = 10_000
): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate((id) => window.getTrpcVanillaClient().pty.getState.query({ sessionId: id }), sessionId),
      {
        timeout: timeoutMs
      }
    )
    .toBe(state)
}

export async function readFullBuffer(page: Page, sessionId: string): Promise<string> {
  return page.evaluate(async (id) => {
    const buffer = await window.getTrpcVanillaClient().pty.getBuffer.query({ sessionId: id })
    return buffer ?? ''
  }, sessionId)
}

export async function readBufferSince(
  page: Page,
  sessionId: string,
  afterSeq: number
): Promise<{ currentSeq: number; chunks: Array<{ seq: number; data: string }> } | null> {
  return page.evaluate(
    ({ id, after }) =>
      window.getTrpcVanillaClient().pty.getBufferSince.query({ sessionId: id, afterSeq: after }),
    {
      id: sessionId,
      after: afterSeq
    }
  )
}

export async function runCommand(page: Page, sessionId: string, command: string): Promise<void> {
  await page.evaluate(
    ({ id, cmd }) => {
      window.getTrpcVanillaClient().pty.write.mutate({ sessionId: id, data: `${cmd}\r` })
    },
    { id: sessionId, cmd: command }
  )
}

export async function waitForBufferContains(
  page: Page,
  sessionId: string,
  needle: string,
  timeoutMs = 10_000
): Promise<void> {
  await expect
    .poll(
      async () => {
        const buffer = await readFullBuffer(page, sessionId)
        return buffer.includes(needle)
      },
      { timeout: timeoutMs }
    )
    .toBe(true)
}

/** Read only the visible viewport rows (not full scrollback) */
export async function getViewportLines(page: Page, sessionId: string): Promise<string[] | null> {
  return page.evaluate(
    ({ sid }) => {
      const links = (window as any).__slayzone_terminalLinks as
        | Record<string, { _terminal: any }>
        | undefined
      const terminal = links?.[sid]?._terminal
      if (!terminal) return null
      const buf = terminal.buffer.active
      const lines: string[] = []
      for (let i = 0; i < terminal.rows; i++) {
        const line = buf.getLine(buf.viewportY + i)
        if (line) lines.push(line.translateToString(true))
      }
      return lines
    },
    { sid: sessionId }
  )
}

/** Read xterm cursor position and visible buffer lines via the terminal links hook */
export async function getTerminalState(
  page: Page,
  sessionId: string
): Promise<{
  cursorY: number
  cursorX: number
  lines: string[]
} | null> {
  return page.evaluate(
    ({ sid }) => {
      const links = (window as any).__slayzone_terminalLinks as
        | Record<string, { _terminal: any }>
        | undefined
      const terminal = links?.[sid]?._terminal
      if (!terminal) return null
      const buf = terminal.buffer.active
      const lines: string[] = []
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i)
        if (line) lines.push(line.translateToString(true))
      }
      return { cursorY: buf.cursorY, cursorX: buf.cursorX, lines }
    },
    { sid: sessionId }
  )
}
