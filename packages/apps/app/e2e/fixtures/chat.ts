/**
 * Chat e2e harness: real chat turns through the real UI against the scripted fake
 * `claude` CLI (`@slayzone/test-utils/fake-claude`, see its README).
 *
 * Import `test` from HERE in `e2e/chat/*.spec.ts`. It overrides `appExtraEnv` so
 * the worker's app starts with `SLAYZONE_COMPUTER_BIN_OVERRIDE_DIR` pointing at the
 * fake's wrapper: the computer then resolves `claude` to the fake for every spawn.
 * Playwright runs these specs in their own worker (their own app); every other
 * group keeps the shared app without the override.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import {
  createFakeClaude,
  type FakeClaude,
  type FakeEpoch,
  type FakeRun,
  type Scenario
} from '@slayzone/test-utils/fake-claude'
import {
  createIsolatedGitRepo,
  expect,
  newRuntimeDir,
  openTaskById,
  seed,
  test as base
} from './electron'
import { closeAllTaskTabs } from './terminal'

export { expect }
export * from '@slayzone/test-utils/fake-claude'

/** A `chat_events` row, parsed. */
export interface ChatEventRow {
  seq: number
  event: { kind: string } & Record<string, unknown>
}

export interface ChatTask {
  taskId: string
  tabId: string
  /** The task's repo (the agent's cwd). */
  cwd: string
  /** Every spawn of the fake for this task's scenario. */
  epoch: FakeEpoch
  page: Page
  /** The visible chat panel of this task. */
  panel: Locator
  composer: Locator
  stopButton: Locator
  sendButton: Locator
  /** Type into the composer and press Enter. */
  send(text: string): Promise<void>
  /** Poll until spawn `index` exists and `pred` holds (default 15 s). */
  run(index: number, pred?: (run: FakeRun) => boolean, timeoutMs?: number): Promise<FakeRun>
  /** The tab's persisted chat events, ordered by seq. */
  events(): Promise<ChatEventRow[]>
  /** Reload the renderer (the hub and the agent keep running) and reopen this task. */
  reload(): Promise<void>
  /** `chat.<op>` input naming this tab (`{tabId, taskId, mode, cwd}`). */
  opts(): { tabId: string; taskId: string; mode: 'claude-chat'; cwd: string }
}

export interface OpenChatTaskOpts {
  title: string
  scenario: Scenario
  /** Seeds `provider_config['claude-chat'].chatConversationId` → the first spawn resumes it. */
  conversationId?: string
  /** Seeds `chat_events` rows (seq = index), as a previous session would have left them. */
  seedEvents?: Array<Record<string, unknown>>
  /**
   * Files written into the task's repo before the task opens (repo-relative path →
   * content), e.g. `.claude/commands/x.md` — the composer lists those once, on mount.
   */
  repoFiles?: Record<string, string>
  /**
   * When the agent spawns. The chat group keeps the reset's `manual` startup: any
   * other mode turns on the warm pool, which pre-boots a TUI `claude` through a
   * login shell — not this fake, possibly the real CLI.
   * - `on-open` (default): openTask spawns it the way the Restart button does
   *   (`chat.start`) and returns once its driver is live (`session-spawn` recorded).
   * - `on-send`: nothing spawns until the first send (the lazy path).
   */
  spawn?: 'on-open' | 'on-send'
}

export interface ChatHarness {
  fake: FakeClaude
  /** Set the scenario, create a claude-chat task in its own repo, open it. */
  openTask(opts: OpenChatTaskOpts): Promise<ChatTask>
  /**
   * Shorten the chat watchdog (test-only tRPC seam; production defaults untouched).
   * `null` restores the defaults; the harness also restores them after every test.
   */
  setWatchdogTimings(
    timings: { startingBoundMs: number; runningStallMs: number; killGraceMs: number } | null
  ): Promise<void>
}

/**
 * Mark the REST of the current test as a known, still-open bug.
 *
 * Call it AFTER the test has asserted its preconditions (the fake was spawned, the
 * event reached the app, …) and right BEFORE the assertion the bug breaks. A
 * harness failure before this line stays red; the bug assertion failing is the
 * expected outcome (green); once the bug is fixed the test "unexpectedly passes",
 * which Playwright reports as a failure — delete the knownBug() call then.
 */
export function knownBug(opts: { audit?: string; fixedBy: string; what: string }): void {
  const id = opts.audit ? `audit ${opts.audit}` : 'found by P0'
  test.info().annotations.push({
    type: 'known-bug',
    description: `${id}: ${opts.what} — fixed by plan item ${opts.fixedBy}`
  })
  // `REVEAL_KNOWN_BUGS=1`: run the bug assertion as a normal one, so its real
  // failure shows — how to check a known bug still fails for the right reason.
  if (process.env.REVEAL_KNOWN_BUGS === '1') return
  test.fail(
    true,
    `KNOWN BUG (${id}): ${opts.what}. Plan item ${opts.fixedBy} fixes it — when this test ` +
      'passes unexpectedly, the bug is fixed: remove this knownBug() call.'
  )
}

type ChatWorkerFixtures = { fakeClaude: FakeClaude }
type ChatFixtures = { chat: ChatHarness }

let projectSeq = 0

export const test = base.extend<ChatFixtures, ChatWorkerFixtures>({
  fakeClaude: [
    async ({}, use) => {
      // Kept after the worker ends (pruned by the global setup like every runtime
      // dir) so a failed run's spawn logs stay inspectable.
      await use(createFakeClaude({ root: newRuntimeDir('fake-claude') }))
    },
    { scope: 'worker' }
  ],

  appExtraEnv: [
    async ({ fakeClaude }, use) => {
      await use({ SLAYZONE_COMPUTER_BIN_OVERRIDE_DIR: fakeClaude.binDir })
    },
    { scope: 'worker' }
  ],

  chat: async ({ mainWindow: page, electronApp, fakeClaude }, use) => {
    let watchdogChanged = false
    const orphansBefore = fakeClaude.orphans().length
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

    const harness: ChatHarness = {
      fake: fakeClaude,

      async openTask(opts) {
        await closeAllTaskTabs(page)
        const epoch = fakeClaude.setScenario(opts.scenario)
        projectSeq += 1
        const repo = createIsolatedGitRepo(`chat-${projectSeq}-${Date.now()}`)
        for (const [rel, content] of Object.entries(opts.repoFiles ?? {})) {
          const file = path.join(repo, rel)
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, content)
        }
        const s = seed(page)
        const project = await s.createProject({
          name: `Chat ${projectSeq}`,
          color: '#22d3ee',
          path: repo
        })
        const task = await s.createTask({
          projectId: project.id,
          title: opts.title,
          status: 'todo',
          terminalMode: 'claude-chat'
        })
        const tabId = await page.evaluate(async (id) => {
          const tab = await window
            .getTrpcVanillaClient()
            .taskTerminals.ensureMain.mutate({ taskId: id, mode: 'claude-chat' })
          return tab.id
        }, task.id)
        if (opts.conversationId) {
          await db.run(
            `UPDATE tasks SET provider_config =
               json_set(COALESCE(provider_config, '{}'), '$."claude-chat".chatConversationId', ?)
             WHERE id = ?`,
            [opts.conversationId, task.id]
          )
        }
        for (const [seq, event] of (opts.seedEvents ?? []).entries()) {
          await db.run('INSERT INTO chat_events (tab_id, seq, event) VALUES (?, ?, ?)', [
            tabId,
            seq,
            JSON.stringify(event)
          ])
        }
        await s.refreshData()
        await openTaskById(page, task.id)
        const panel = page.locator('[data-chat-panel]:visible')
        await expect(panel).toBeVisible({ timeout: 10_000 })
        const composer = panel.locator('textarea')
        if ((opts.spawn ?? 'on-open') === 'on-open') {
          // Pre-spawn the way the Restart button does. Once `chat.start` has
          // returned, the driver is live for any later request: the routed handle
          // starts it one tick after the spawn call (exec-proxies.ts onSpawn
          // setImmediate), before this response even leaves the hub. A send that
          // itself spawns the agent races that tick and is dropped today (140's
          // lazy-spawn known bug) — so this is how a test relies on its first
          // message arriving.
          await page.evaluate((o) => window.getTrpcVanillaClient().chat.start.mutate(o), {
            tabId,
            taskId: task.id,
            mode: 'claude-chat',
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
          sendButton: panel.getByRole('button', { name: 'Send' }),
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
          async reload() {
            await page.reload({ waitUntil: 'domcontentloaded' })
            await openTaskById(page, task.id)
            await expect(panel).toBeVisible({ timeout: 10_000 })
          },
          opts: () => ({ tabId, taskId: task.id, mode: 'claude-chat', cwd: repo })
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
    // Fail closed on harness drift: an unscripted spawn means the app spawned more
    // agents than the scenario expected (a respawn nobody asked for); argv drift
    // means the adapter changed the flags the fake requires; an orphan means a
    // spawn found no scenario at all.
    const epoch = (() => {
      try {
        return fakeClaude.current()
      } catch {
        return null
      }
    })()
    const problems = [
      ...(epoch?.unscripted() ?? []).map(
        (r) => `unscripted spawn #${r.index} (argv ${r.argv.join(' ')})`
      ),
      ...(epoch?.argvDrift() ?? []).map(
        (r) => `argv drift in spawn #${r.index}: ${JSON.stringify(r.entries[1])}`
      ),
      ...fakeClaude
        .orphans()
        .slice(orphansBefore)
        .map((e) => `spawn with no scenario: ${JSON.stringify(e)}`)
    ]
    if (problems.length > 0) throw new Error(`fake-claude guard:\n  ${problems.join('\n  ')}`)
  }
})
