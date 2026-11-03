/**
 * A Claude session that moved folders (EnterWorktree) resumes with its own
 * conversation, from the folder it last worked in — never starts fresh over it.
 *
 * Regression (2026-11-03, task 5c34ebb9): after EnterWorktree the CLI keeps the
 * transcript ONLY under the worktree's project dir. The conversation healer
 * looked in the task folder alone, read "never written", and the restart ran
 * `claude --session-id <same id>`: a fresh session that later superseded the
 * real 10 MB transcript. Now the agent's computer locates the transcript
 * (`claudeSession.locate`) and the terminal resumes it in the worktree.
 *
 * Real hub → computer → pty path; the CLI is the scripted fake (TUI run for the
 * terminal, pointed at by absolute path as in 154-chat-handoff).
 */
import {
  mkdirSync,
  readdirSync,
  renameSync,
  appendFileSync,
  existsSync,
  realpathSync
} from 'node:fs'
import path from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import { resetApp } from '../fixtures/electron'
import { echoTurn, expect, test } from '../fixtures/chat'

async function fakeTerminalAgent(
  electronApp: ElectronApplication,
  claudeBin: string
): Promise<() => Promise<void>> {
  return electronApp
    .evaluate(async ({}, bin) => {
      const db = (globalThis as Record<string, unknown>).__db as {
        get: (sql: string, params?: unknown[]) => Promise<{ i: string; r: string } | undefined>
        run: (sql: string, params?: unknown[]) => Promise<unknown>
      }
      const before = await db.get(
        `SELECT initial_command AS i, resume_command AS r FROM terminal_modes WHERE id = 'claude-code'`
      )
      await db.run(
        `UPDATE terminal_modes SET initial_command = ?, resume_command = ? WHERE id = 'claude-code'`,
        [`${bin} --session-id {id} {flags}`, `${bin} --resume {id} {flags}`]
      )
      return before
    }, claudeBin)
    .then((before) => async () => {
      await electronApp.evaluate(async ({}, b) => {
        const db = (globalThis as Record<string, unknown>).__db as {
          run: (sql: string, params?: unknown[]) => Promise<unknown>
        }
        await db.run(
          `UPDATE terminal_modes SET initial_command = ?, resume_command = ? WHERE id = 'claude-code'`,
          [b?.i ?? null, b?.r ?? null]
        )
      }, before)
    })
}

/** The CLI's project-dir name for a folder. */
const encode = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-')

/** Where the fake keeps `<id>.jsonl` (any project dir under the config dir). */
function sessionFileOf(configDir: string, id: string): string {
  const projects = path.join(configDir, 'projects')
  for (const dir of readdirSync(projects)) {
    const file = path.join(projects, dir, `${id}.jsonl`)
    if (existsSync(file)) return file
  }
  throw new Error(`no session file for ${id}`)
}

test.describe('Resume a Claude session that moved into a worktree', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('continue in terminal after EnterWorktree: --resume, started in the worktree', async ({
    chat,
    electronApp
  }) => {
    const undo = await fakeTerminalAgent(electronApp, path.join(chat.fake.binDir, 'claude'))
    try {
      const t = await chat.openTask({
        title: 'Moved session',
        scenario: { processes: [{ defaultTurn: echoTurn() }, { tui: true }] }
      })
      await t.send('one')
      await expect(t.panel.getByText('echo: one')).toBeVisible()
      const conv = (await t.run(0)).sessionId!

      // What EnterWorktree leaves on disk: the transcript only under the
      // worktree's project dir, with a `relocated` record naming the worktree.
      const worktree = path.join(t.cwd, '.claude', 'worktrees', 'wt1')
      mkdirSync(worktree, { recursive: true })
      const original = sessionFileOf(chat.claudeConfigDir, conv)
      const movedDir = path.join(chat.claudeConfigDir, 'projects', encode(worktree))
      mkdirSync(movedDir, { recursive: true })
      const moved = path.join(movedDir, `${conv}.jsonl`)
      renameSync(original, moved)
      appendFileSync(
        moved,
        `${JSON.stringify({ type: 'relocated', sessionId: conv, relocatedCwd: worktree })}\n`
      )

      await t.panel.getByText('echo: one').click({ button: 'right' })
      await t.page.getByTestId('chat-continue-in-terminal').click()
      const tui = await t.run(1)
      expect(tui.tui).toBe(true)
      // Resumed — never `--session-id <conv>` (a fresh session over the transcript).
      expect(tui.flag('--resume')).toBe(conv)
      expect(tui.argv).not.toContain('--session-id')
      // From the folder the session last worked in.
      expect(realpathSync(tui.cwd)).toBe(realpathSync(worktree))
      // The transcript is still the one and only, where the session left it.
      expect(sessionFileOf(chat.claudeConfigDir, conv)).toBe(moved)
    } finally {
      await undo()
    }
  })
})
