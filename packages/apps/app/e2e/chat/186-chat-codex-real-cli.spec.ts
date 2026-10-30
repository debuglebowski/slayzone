/**
 * Codex chat against the REAL codex app-server (X1 "done when": a real codex
 * 0.159.2 turn runs end to end in the app). Opt-in — it uses the developer's
 * Codex login and the OpenAI backend (cheapest model, low effort, two short
 * turns), so it skips unless all of these are set:
 *  - `SLAYZONE_E2E_REAL_CODEX_HOME=1`: the app keeps the real ~/.codex (its login);
 *  - `SLAYZONE_CODEX_BIN_PATH`: the codex to run (e.g. 0.159.2 installed aside with
 *    `npm i --prefix <dir> @openai/codex@0.159.2` → `<dir>/node_modules/.bin/codex`);
 *  - `SLAYZONE_CODEX_RECORD_DIR`: the ONE fixed work dir (Codex adds a trust entry
 *    for every cwd it starts a thread in; one dir = one entry).
 * Afterwards move the rollout files it created out of ~/.codex/sessions
 * (fake-codex README, "e2e").
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, openTaskById, resetApp, seed, test as base } from '../fixtures/electron'
import { closeAllTaskTabs } from '../fixtures/terminal'

const BIN = process.env.SLAYZONE_CODEX_BIN_PATH ?? ''
const WORK_DIR = process.env.SLAYZONE_CODEX_RECORD_DIR ?? ''
const ENABLED = process.env.SLAYZONE_E2E_REAL_CODEX_HOME === '1' && BIN !== '' && WORK_DIR !== ''
/** The cheapest model 0.159.2 offers this account (recorder MODEL). */
const MODEL = 'gpt-6-luna'

const test = base.extend<object, { appExtraEnv: Record<string, string> }>({
  appExtraEnv: [
    async ({}, use) => {
      // The real codex first on the computer's PATH (the global one may be too old).
      await use(ENABLED ? { SLAYZONE_COMPUTER_BIN_OVERRIDE_DIR: path.dirname(BIN) } : {})
    },
    { scope: 'worker' }
  ]
})

test.describe('Codex chat — real codex app-server', () => {
  test.skip(
    !ENABLED,
    'opt-in: SLAYZONE_E2E_REAL_CODEX_HOME=1 + SLAYZONE_CODEX_BIN_PATH + SLAYZONE_CODEX_RECORD_DIR'
  )

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('a turn runs end to end; a restart resumes the same thread', async ({
    mainWindow: page,
    electronApp
  }) => {
    test.setTimeout(240_000)
    fs.mkdirSync(WORK_DIR, { recursive: true })
    const db = <T>(sql: string, params: unknown[] = []) =>
      electronApp.evaluate(
        async ({}, { q, p }) =>
          (
            (globalThis as Record<string, unknown>).__db as {
              all: (sql: string, params?: unknown[]) => Promise<unknown[]>
            }
          ).all(q, p),
        { q: sql, p: params }
      ) as Promise<T[]>
    await closeAllTaskTabs(page)
    const s = seed(page)
    const project = await s.createProject({ name: 'Codex real', color: '#a78bfa', path: WORK_DIR })
    const task = await s.createTask({
      projectId: project.id,
      title: 'Codex real CLI',
      status: 'todo',
      terminalMode: 'codex-chat'
    })
    const tabId = await page.evaluate(async (id) => {
      const tab = await window
        .getTrpcVanillaClient()
        .taskTerminals.ensureMain.mutate({ taskId: id, mode: 'codex-chat' })
      return tab.id
    }, task.id)
    await s.refreshData()
    await openTaskById(page, task.id)
    const panel = page.locator('[data-chat-panel]:visible')
    await expect(panel).toBeVisible({ timeout: 10_000 })
    const o = { tabId, taskId: task.id, mode: 'codex-chat', cwd: WORK_DIR }
    const trpc = <T>(fn: string, input: unknown) =>
      page.evaluate(
        ({ fn, input }) => {
          const [ns, op, kind] = fn.split('.')
          const c = window.getTrpcVanillaClient() as unknown as Record<
            string,
            Record<string, Record<string, (i: unknown) => Promise<unknown>>>
          >
          return c[ns][op][kind](input)
        },
        { fn, input }
      ) as Promise<T>
    const events = async () =>
      (
        await db<{ event: string }>('SELECT event FROM chat_events WHERE tab_id = ? ORDER BY seq', [
          tabId
        ])
      ).map((r) => JSON.parse(r.event) as Record<string, unknown> & { kind: string })

    await trpc('chat.setModel.mutate', { ...o, chatModel: MODEL })
    await trpc('chat.setEffort.mutate', { ...o, chatEffort: 'low' })
    await trpc('chat.start.mutate', o)
    // The handshake: the CLI version, and the account's models stored for the picker.
    await expect
      .poll(async () => (await events()).find((e) => e.kind === 'turn-init')?.cliVersion, {
        timeout: 30_000
      })
      .toBe('0.159.2')
    await expect
      .poll(
        async () =>
          (
            await trpc<Array<{ id: string }>>('chat.getModels.query', {
              taskId: task.id,
              mode: 'codex-chat'
            })
          ).map((m) => m.id),
        { timeout: 30_000 }
      )
      .toContain(MODEL)

    const composer = panel.locator('textarea')
    await composer.fill('Reply with exactly the word: pong')
    await composer.press('Enter')
    await expect
      .poll(async () => (await events()).filter((e) => e.kind === 'result').length, {
        timeout: 120_000
      })
      .toBe(1)
    const after1 = await events()
    const result = after1.find((e) => e.kind === 'result')!
    expect(result.isError).toBe(false)
    expect(after1.some((e) => e.kind === 'error')).toBe(false)
    expect(after1.some((e) => e.kind === 'assistant-text' && /pong/i.test(String(e.text)))).toBe(
      true
    )
    expect(after1.some((e) => e.kind === 'context-usage')).toBe(true)
    const thread = String(after1.find((e) => e.kind === 'turn-init')!.sessionId)
    const ledger = await db<{ id: string; origin: string }>(
      `SELECT conversation_id AS id, origin FROM task_conversations
         WHERE task_id = ? AND mode = 'codex-chat' ORDER BY created_at, rowid`,
      [task.id]
    )
    expect(ledger).toContainEqual({ id: thread, origin: 'slay-spawned-fresh' })

    // Restart: the same thread resumes, and Codex still has the conversation.
    await trpc('chat.kill.mutate', { tabId })
    await panel
      .getByRole('button', { name: /Session ended, click to restart/ })
      .click({ timeout: 15_000 })
    await expect(composer).toBeEnabled({ timeout: 30_000 })
    await composer.fill('What word did you reply with before? Reply with that word only.')
    await composer.press('Enter')
    await expect
      .poll(async () => (await events()).filter((e) => e.kind === 'result').length, {
        timeout: 120_000
      })
      .toBe(2)
    const after2 = await events()
    const inits = after2.filter((e) => e.kind === 'turn-init').map((e) => e.sessionId)
    expect(new Set(inits)).toEqual(new Set([thread]))
    const lastText = after2.filter((e) => e.kind === 'assistant-text').at(-1)
    expect(String(lastText?.text)).toMatch(/pong/i)
  })
})
