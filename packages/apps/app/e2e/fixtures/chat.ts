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
import {
  createFakeClaude,
  type FakeClaude,
  type FakeEpoch,
  type FakeRun,
  type Scenario,
  sessionFilePath
} from '@slayzone/test-utils/fake-claude'
import { expect, newRuntimeDir, test as base } from './electron'
import { closeAllTaskTabs } from './terminal'
import {
  chatDb,
  openChatTaskCore,
  setChatWatchdogTimings,
  type ChatEventRow,
  type ChatTaskCore
} from './chat-task-core'

export { expect, type ChatEventRow }
export * from '@slayzone/test-utils/fake-claude'

export interface ChatTask extends ChatTaskCore<'claude-chat'> {
  /** Every spawn of the fake for this task's scenario. */
  epoch: FakeEpoch
  /** Poll until spawn `index` exists and `pred` holds (default 15 s). */
  run(index: number, pred?: (run: FakeRun) => boolean, timeoutMs?: number): Promise<FakeRun>
  /** The CLI session file of a conversation in this task's repo (the fake writes it). */
  sessionFile(sessionId: string): string
}

export interface OpenChatTaskOpts {
  title: string
  /** Task description (markdown), e.g. for the inject-description shortcut. */
  description?: string
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
  /**
   * The worker's `CLAUDE_CONFIG_DIR` (the app and every agent it spawns get it):
   * the fake keeps its session files here, never in the real ~/.claude.
   */
  claudeConfigDir: string
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

type ChatWorkerFixtures = { fakeClaude: FakeClaude; claudeConfigDir: string }
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

  claudeConfigDir: [
    async ({}, use) => {
      await use(newRuntimeDir('claude-config'))
    },
    { scope: 'worker' }
  ],

  appExtraEnv: [
    async ({ fakeClaude, claudeConfigDir }, use) => {
      await use({
        SLAYZONE_COMPUTER_BIN_OVERRIDE_DIR: fakeClaude.binDir,
        CLAUDE_CONFIG_DIR: claudeConfigDir
      })
    },
    { scope: 'worker' }
  ],

  chat: async ({ mainWindow: page, electronApp, fakeClaude, claudeConfigDir }, use) => {
    let watchdogChanged = false
    const orphansBefore = fakeClaude.orphans().length
    const db = chatDb(electronApp)

    const harness: ChatHarness = {
      fake: fakeClaude,
      claudeConfigDir,

      async openTask(opts) {
        await closeAllTaskTabs(page)
        const epoch = fakeClaude.setScenario(opts.scenario)
        projectSeq += 1
        const core = await openChatTaskCore({
          page,
          electronApp,
          db,
          mode: 'claude-chat',
          repoName: `chat-${projectSeq}-${Date.now()}`,
          project: { name: `Chat ${projectSeq}`, color: '#22d3ee' },
          title: opts.title,
          description: opts.description,
          conversationId: opts.conversationId,
          seedEvents: opts.seedEvents,
          repoFiles: opts.repoFiles,
          spawn: opts.spawn,
          waitForFirstRun: () => epoch.waitForRun(0)
        })
        return {
          ...core,
          epoch,
          run: (index, pred, timeoutMs) => epoch.waitForRun(index, pred, timeoutMs),
          // The CLI keys its project dir by its real cwd (symlinks resolved).
          sessionFile: (sessionId) =>
            sessionFilePath(claudeConfigDir, fs.realpathSync(core.cwd), sessionId)
        }
      },

      async setWatchdogTimings(timings) {
        watchdogChanged = timings !== null
        await setChatWatchdogTimings(page, timings)
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
