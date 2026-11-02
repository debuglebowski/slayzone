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
import {
  createFakeCodex,
  type CodexScenario,
  type FakeCodex,
  type FakeCodexEpoch,
  type FakeCodexRun
} from '@slayzone/test-utils/fake-codex'
import { knownBug } from './chat'
import { expect, newRuntimeDir, test as base } from './electron'
import { closeAllTaskTabs } from './terminal'
import {
  chatDb,
  openChatTaskCore,
  setChatWatchdogTimings,
  type ChatEventRow,
  type ChatTaskCore
} from './chat-task-core'

export { expect, knownBug, type ChatEventRow }
export * from '@slayzone/test-utils/fake-codex'

export interface CodexChatTask extends ChatTaskCore<'codex-chat'> {
  /** Every spawn of the fake for this task's scenario. */
  epoch: FakeCodexEpoch
  /** Poll until spawn `index` exists and `pred` holds (default 15 s). */
  run(
    index: number,
    pred?: (run: FakeCodexRun) => boolean,
    timeoutMs?: number
  ): Promise<FakeCodexRun>
  /** The task's stored Codex thread id (`provider_config` mirror of the honored row), or null. */
  storedThread(): Promise<string | null>
  /** The task's conversation ledger (`task_conversations`) for codex-chat, oldest first. */
  conversations(): Promise<Array<{ conversationId: string | null; origin: string }>>
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
    const db = chatDb(electronApp)

    const harness: CodexChatHarness = {
      fake: fakeCodex,

      async openTask(opts) {
        await closeAllTaskTabs(page)
        const epoch = fakeCodex.setScenario(opts.scenario)
        projectSeq += 1
        const core = await openChatTaskCore({
          page,
          electronApp,
          db,
          mode: 'codex-chat',
          repoName: `codex-chat-${projectSeq}-${Date.now()}`,
          project: { name: `Codex chat ${projectSeq}`, color: '#a78bfa' },
          title: opts.title,
          conversationId: opts.conversationId,
          seedEvents: opts.seedEvents,
          spawn: opts.spawn,
          waitForFirstRun: () => epoch.waitForRun(0)
        })
        return {
          ...core,
          epoch,
          run: (index, pred, timeoutMs) => epoch.waitForRun(index, pred, timeoutMs),
          async storedThread() {
            const rows = await db.all<{ id: string | null }>(
              `SELECT json_extract(provider_config, '$."codex-chat".chatConversationId') AS id
                 FROM tasks WHERE id = ?`,
              [core.taskId]
            )
            return rows[0]?.id ?? null
          },
          async conversations() {
            return db.all<{ conversationId: string | null; origin: string }>(
              `SELECT conversation_id AS conversationId, origin FROM task_conversations
                 WHERE task_id = ? AND mode = 'codex-chat' ORDER BY created_at, rowid`,
              [core.taskId]
            )
          }
        }
      },

      async setWatchdogTimings(timings) {
        watchdogChanged = timings !== null
        await setChatWatchdogTimings(page, timings)
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
