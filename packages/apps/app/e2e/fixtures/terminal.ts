import type { Page } from '@playwright/test'
import { expect } from './electron'
import { clickProject, goHome } from './electron'
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
  opencode: `${homedir()}/.opencode/bin/opencode`,
} as const

function activeModeTrigger(page: Page) {
  return page.locator('[data-testid="terminal-mode-trigger"]:visible').first()
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
  await goHome(page)
  await clickProject(page, opts.projectAbbrev)

  const taskCardTitle = page.locator('p.line-clamp-3:visible', { hasText: opts.taskTitle }).first()
  if (await taskCardTitle.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await taskCardTitle.click()
  } else {
    await page.keyboard.press('Meta+k')
    const searchInput = page.getByPlaceholder('Search tasks and projects...')
    await expect(searchInput).toBeVisible()
    await searchInput.fill(opts.taskTitle)
    const dialog = page.locator('[role="dialog"]:visible').last()
    await dialog.getByText(opts.taskTitle).first().click()
  }

  await expect(activeModeTrigger(page)).toBeVisible()
  await expect(page.locator('[data-testid="terminal-tabbar"]:visible').first()).toBeVisible()
}

export async function switchTerminalMode(page: Page, mode: TerminalMode): Promise<void> {
  const labels: Record<TerminalMode, string[]> = {
    'claude-code': ['Claude', 'Claude Code'],
    codex: ['Codex'],
    'cursor-agent': ['Cursor', 'Cursor Agent'],
    gemini: ['Gemini'],
    opencode: ['OpenCode'],
    copilot: ['Copilot'],
    terminal: ['Terminal'],
  }

  // Dismiss any blocking overlay (dialog, popover, select) that may linger from a previous test
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(100)

  // Radix Dialog scroll-lock (react-remove-scroll) can leave pointer-events:none on <body>
  // if the dialog close animation completes before the cleanup runs. Force-clear it.
  await page.evaluate(() => {
    if (getComputedStyle(document.body).pointerEvents === 'none') {
      document.body.style.pointerEvents = ''
    }
  })

  const trigger = activeModeTrigger(page)
  await trigger.click()

  const optionByValue = page.locator(`[role="option"][data-value="${mode}"]`).first()
  if (await optionByValue.isVisible({ timeout: 2_000 }).catch(() => false)) {
    const selectedLabel = (await optionByValue.textContent())?.trim()
    await optionByValue.click()
    if (selectedLabel) {
      await expect(trigger).toContainText(selectedLabel)
      return
    }
  }

  for (const label of labels[mode] ?? [mode]) {
    const option = page.getByRole('option', { name: label, exact: true })
    if (await option.isVisible({ timeout: 800 }).catch(() => false)) {
      await option.click()
      await expect(trigger).toContainText(label)
      return
    }
  }

  throw new Error(`Terminal mode option not found: ${mode}`)
}

export async function waitForPtySession(
  page: Page,
  sessionId: string,
  timeoutMs = 20_000
): Promise<void> {
  await expect
    .poll(
      async () => page.evaluate((id) => window.api.pty.exists(id), sessionId),
      { timeout: timeoutMs }
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
      async () => page.evaluate((id) => window.api.pty.exists(id), sessionId),
      { timeout: timeoutMs }
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
      async () => page.evaluate((id) => window.api.pty.getState(id), sessionId),
      { timeout: timeoutMs }
    )
    .toBe(state)
}

export async function readFullBuffer(page: Page, sessionId: string): Promise<string> {
  return page.evaluate(async (id) => {
    const buffer = await window.api.pty.getBuffer(id)
    return buffer ?? ''
  }, sessionId)
}

export async function readBufferSince(
  page: Page,
  sessionId: string,
  afterSeq: number
): Promise<{ currentSeq: number; chunks: Array<{ seq: number; data: string }> } | null> {
  return page.evaluate(
    ({ id, after }) => window.api.pty.getBufferSince(id, after),
    { id: sessionId, after: afterSeq }
  )
}

export async function runCommand(page: Page, sessionId: string, command: string): Promise<void> {
  await page.evaluate(
    ({ id, cmd }) => {
      window.api.pty.write(id, `${cmd}\r`)
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
    .poll(async () => {
      const buffer = await readFullBuffer(page, sessionId)
      return buffer.includes(needle)
    }, { timeout: timeoutMs })
    .toBe(true)
}

/** Read only the visible viewport rows (not full scrollback) */
export async function getViewportLines(page: Page, sessionId: string): Promise<string[] | null> {
  return page.evaluate(({ sid }) => {
    const links = (window as any).__slayzone_terminalLinks as
      Record<string, { _terminal: any }> | undefined
    const terminal = links?.[sid]?._terminal
    if (!terminal) return null
    const buf = terminal.buffer.active
    const lines: string[] = []
    for (let i = 0; i < terminal.rows; i++) {
      const line = buf.getLine(buf.viewportY + i)
      if (line) lines.push(line.translateToString(true))
    }
    return lines
  }, { sid: sessionId })
}

/** Read xterm cursor position and visible buffer lines via the terminal links hook */
export async function getTerminalState(page: Page, sessionId: string): Promise<{
  cursorY: number
  cursorX: number
  lines: string[]
} | null> {
  return page.evaluate(({ sid }) => {
    const links = (window as any).__slayzone_terminalLinks as
      Record<string, { _terminal: any }> | undefined
    const terminal = links?.[sid]?._terminal
    if (!terminal) return null
    const buf = terminal.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i)
      if (line) lines.push(line.translateToString(true))
    }
    return { cursorY: buf.cursorY, cursorX: buf.cursorX, lines }
  }, { sid: sessionId })
}
