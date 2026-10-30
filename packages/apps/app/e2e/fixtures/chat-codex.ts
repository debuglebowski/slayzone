/**
 * Codex chat e2e harness: real Codex chat turns through the real UI against the
 * scripted fake `codex app-server` (`@slayzone/test-utils/fake-codex`, see its
 * README). The Codex twin of fixtures/chat.ts (Claude): same shape, same guard,
 * same `knownBug()`.
 *
 * Import `test` from HERE in `e2e/chat/17x-chat-codex-*.spec.ts`. It overrides
 * `appExtraEnv` so the worker's app starts with `SLAYZONE_COMPUTER_BIN_OVERRIDE_DIR`
 * pointing at the fake's wrapper: the computer then resolves `codex` to the fake
 * for every spawn (the bin dir holds no `claude`, so these specs never start
 * Claude). Playwright runs these specs in their own worker (their own app).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import {
  createFakeCodex,
  type CodexScenario,
  type FakeCodex,
  type FakeCodexEpoch,
  type FakeCodexRun
} from '@slayzone/test-utils/fake-codex'
import { knownBug, type ChatEventRow } from './chat'
import {
  createIsolatedGitRepo,
  expect,
  newRuntimeDir,
  openTaskById,
  seed,
  test as base
} from './electron'
import { closeAllTaskTabs } from './terminal'

export { expect, knownBug, type ChatEventRow }
export * from '@slayzone/test-utils/fake-codex'

export interface CodexChatTask {
  taskId: string
  tabId: string
  /** The task's repo (the agent's cwd). */
  cwd: string
  /** Every spawn of the fake for this task's scenario. */
  epoch: FakeCodexEpoch
  page: Page
  /** The visible chat panel of this task. */
  panel: Locator
  composer: Locator
  stopButton: Locator
  sendButton: Locator
  /** Type into the composer and press Enter. */
  send(text: string): Promise<void>
  /** Poll until spawn `index` exists and `pred` holds (default 15 s). */
  run(
    index: number,
    pred?: (run: FakeCodexRun) => boolean,
    timeoutMs?: number
  ): Promise<FakeCodexRun>
  /** The tab's persisted chat events, ordered by seq. */
  events(): Promise<ChatEventRow[]>
  /** The task's stored Codex thread id (`provider_config` mirror of the honored row), or null. */
  storedThread(): Promise<string | null>
  /** The task's conversation ledger (`task_conversations`) for codex-chat, oldest first. */
  conversations(): Promise<Array<{ conversationId: string | null; origin: string }>>
  /** Reload the renderer (the hub and the agent keep running) and reopen this task. */
  reload(): Promise<void>
  /** `chat.<op>` input naming this tab. */
  opts(): { tabId: string; taskId: string; mode: 'codex-chat'; cwd: string }
}

export interface OpenCodexChatTaskOpts {
  title: string
  scenario: CodexScenario
  /** Seeds the stored conversation (thread) id → the first spawn resumes it. */
  conversationId?: string
  /** Seeds `chat_events` rows (seq = index), as a previous session would have left them. */
  seedEvents?: Array<Record<string, unknown>>
  /** `on-open` (default): spawned the way the Restart button does. `on-send`: lazily. */
  spawn?: 'on-open' | 'on-send'
}

export interface CodexChatHarness {
  fake: FakeCodex
  openTask(opts: OpenCodexChatTaskOpts): Promise<CodexChatTask>
  setWatchdogTimings(
    timings: { startingBoundMs: number; runningStallMs: number; killGraceMs: number } | null
  ): Promise<void>
}

type Fixtures = { codexChat: CodexChatHarness }
type WorkerFixtures = { fakeCodex: FakeCodex }

let projectSeq = 0
const SEED_CHUNK = 100

export const test = base.extend<Fixtures, WorkerFixtures>({
  fakeCodex: [
    async ({}, use) => {
      // Kept after the worker ends (pruned by the global setup) so a failed run's
      // spawn logs stay inspectable.
      await use(createFakeCodex({ root: newRuntimeDir('fake-codex') }))
    },
    { scope: 'worker' }
  ],

  appExtraEnv: [
    async ({ fakeCodex }, use) => {
      await use({ SLAYZONE_COMPUTER_BIN_OVERRIDE_DIR: fakeCodex.binDir })
    },
    { scope: 'worker' }
  ],

  codexChat: async ({ mainWindow: page, electronApp, fakeCodex }, use) => {
    let watchdogChanged = false
    const orphansBefore = fakeCodex.orphans().length
    const db = {
      all: <T>(sql: string, params: unknown[] = []) =>
        electronApp.evaluate(
          async ({}, { q, p }) => {
            const d = (globalThis as Record<string, unknown>).__db as {
              all: (sql: string, params?: unknown[]) => Promise<unknown[]>
            }
            return d.all(q, p)
          },
          { q: sql, p: params }
        ) as Promise<T[]>,
      run: (sql: string, params: unknown[] = []) =>
        electronApp.evaluate(
          async ({}, { q, p }) => {
            const d = (globalThis as Record<string, unknown>).__db as {
              run: (sql: string, params?: unknown[]) => Promise<unknown>
            }
            await d.run(q, p)
          },
          { q: sql, p: params }
        )
    }

    const harness: CodexChatHarness = {
      fake: fakeCodex,

      async openTask(opts) {
        await closeAllTaskTabs(page)
        const epoch = fakeCodex.setScenario(opts.scenario)
        projectSeq += 1
        const repo = createIsolatedGitRepo(`codex-chat-${projectSeq}-${Date.now()}`)
        const s = seed(page)
        const project = await s.createProject({
          name: `Codex chat ${projectSeq}`,
          color: '#a78bfa',
          path: repo
        })
        const task = await s.createTask({
          projectId: project.id,
          title: opts.title,
          status: 'todo',
          terminalMode: 'codex-chat'
        })
        const tabId = await page.evaluate(async (id) => {
          const tab = await window
            .getTrpcVanillaClient()
            .taskTerminals.ensureMain.mutate({ taskId: id, mode: 'codex-chat' })
          return tab.id
        }, task.id)
        if (opts.conversationId) {
          await db.run(
            `UPDATE tasks SET provider_config =
               json_set(COALESCE(provider_config, '{}'), '$."codex-chat".chatConversationId', ?)
             WHERE id = ?`,
            [opts.conversationId, task.id]
          )
        }
        const seedRows = (opts.seedEvents ?? []).map((event, seq) => [
          tabId,
          seq,
          JSON.stringify(event)
        ])
        for (let at = 0; at < seedRows.length; at += SEED_CHUNK) {
          const chunk = seedRows.slice(at, at + SEED_CHUNK)
          await db.run(
            `INSERT INTO chat_events (tab_id, seq, event) VALUES ${chunk.map(() => '(?, ?, ?)').join(', ')}`,
            chunk.flat()
          )
        }
        await s.refreshData()
        await openTaskById(page, task.id)
        const panel = page.locator('[data-chat-panel]:visible')
        await expect(panel).toBeVisible({ timeout: 10_000 })
        const composer = panel.locator('textarea')
        if ((opts.spawn ?? 'on-open') === 'on-open') {
          // As fixtures/chat.ts: pre-spawn the way the Restart button does, so a
          // test can rely on its first message arriving.
          await page.evaluate((o) => window.getTrpcVanillaClient().chat.start.mutate(o), {
            tabId,
            taskId: task.id,
            mode: 'codex-chat',
            cwd: repo
          })
          await epoch.waitForRun(0)
        }
        return {
          taskId: task.id,
          tabId,
          cwd: repo,
          epoch,
          page,
          panel,
          composer,
          stopButton: panel.getByRole('button', { name: 'Stop generation' }),
          sendButton: panel.getByRole('button', { name: 'Send', exact: true }),
          async send(text) {
            await expect(composer).toBeEnabled()
            await composer.fill(text)
            await composer.press('Enter')
          },
          run: (index, pred, timeoutMs) => epoch.waitForRun(index, pred, timeoutMs),
          async events() {
            const rows = await db.all<{ seq: number; event: string }>(
              'SELECT seq, event FROM chat_events WHERE tab_id = ? ORDER BY seq',
              [tabId]
            )
            return rows.map((r) => ({
              seq: r.seq,
              event: JSON.parse(r.event) as ChatEventRow['event']
            }))
          },
          async storedThread() {
            const rows = await db.all<{ id: string | null }>(
              `SELECT json_extract(provider_config, '$."codex-chat".chatConversationId') AS id
                 FROM tasks WHERE id = ?`,
              [task.id]
            )
            return rows[0]?.id ?? null
          },
          async conversations() {
            return db.all<{ conversationId: string | null; origin: string }>(
              `SELECT conversation_id AS conversationId, origin FROM task_conversations
                 WHERE task_id = ? AND mode = 'codex-chat' ORDER BY created_at, rowid`,
              [task.id]
            )
          },
          async reload() {
            await page.reload({ waitUntil: 'domcontentloaded' })
            await openTaskById(page, task.id)
            await expect(panel).toBeVisible({ timeout: 10_000 })
          },
          opts: () => ({ tabId, taskId: task.id, mode: 'codex-chat', cwd: repo })
        }
      },

      async setWatchdogTimings(timings) {
        watchdogChanged = timings !== null
        await page.evaluate(
          (t) => window.getTrpcVanillaClient().chat.testSetWatchdogTimings.mutate({ timings: t }),
          timings
        )
      }
    }

    await use(harness)

    if (watchdogChanged) await harness.setWatchdogTimings(null).catch(() => {})
    // Fail closed on harness drift, as fixtures/chat.ts does.
    const epoch = (() => {
      try {
        return fakeCodex.current()
      } catch {
        return null
      }
    })()
    const problems = [
      ...(epoch?.unscripted() ?? []).map(
        (r) => `unscripted spawn #${r.index} (argv ${r.argv.join(' ')})`
      ),
      ...(epoch?.argvDrift() ?? []).map(
        (r) => `argv drift in spawn #${r.index}: ${JSON.stringify(r.argv)}`
      ),
      ...fakeCodex
        .orphans()
        .slice(orphansBefore)
        .filter((e) => e.kind === 'unscripted')
        .map((e) => `spawn with no scenario: ${JSON.stringify(e)}`)
    ]
    if (problems.length > 0) throw new Error(`fake-codex guard:\n  ${problems.join('\n  ')}`)
  }
})

/** Where a fake-codex spawn's own state lives (for a spec that inspects it). */
export function fakeCodexThreadFile(fake: FakeCodex, threadId: string): string {
  return path.join(fake.stateDir, 'threads', `${threadId}.json`)
}

/** True when the fake knows `threadId` (started it, or the scenario seeded it). */
export function fakeCodexKnowsThread(fake: FakeCodex, threadId: string): boolean {
  return fs.existsSync(fakeCodexThreadFile(fake, threadId))
}
