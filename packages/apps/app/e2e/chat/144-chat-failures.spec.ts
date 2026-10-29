/**
 * Claude Code chat: the CLI failing under a turn — a crash, a truly stalled turn,
 * and a long silent tool the watchdog must not mistake for one (audit #4) —
 * against the scripted fake CLI.
 */
import { resetApp } from '../fixtures/electron'
import { ev, expect, knownBug, step, test } from '../fixtures/chat'

/** Short enough to see the watchdog act; production keeps 20 s / 300 s / 2 s. */
const FAST_WATCHDOG = { startingBoundMs: 20_000, runningStallMs: 1_500, killGraceMs: 500 }

test.describe('Chat failures', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('a CLI crash mid-turn ends the session visibly and shows why', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Chat crash',
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(ev.init(), ev.text('about to crash')),
                step.stderr('panic: fake-claude crashed on purpose\n'),
                step.exit(1)
              ]
            ]
          }
        ]
      }
    })
    await t.send('do the thing')
    await expect(t.panel.getByText('about to crash')).toBeVisible()
    await t.run(0, (r) => r.exit()?.code === 1)

    await expect(
      t.panel.getByRole('button', { name: /Session ended, click to restart/ })
    ).toBeVisible()
    await expect(t.composer).toBeDisabled()
    await expect(t.panel.getByText('panic: fake-claude crashed on purpose')).toBeVisible()
  })

  test('the watchdog still ends a turn that has truly stalled', async ({ chat }) => {
    await chat.setWatchdogTimings(FAST_WATCHDOG)
    const t = await chat.openTask({
      title: 'Chat stall',
      scenario: {
        processes: [{ turns: [[step.emit(ev.init(), ev.text('then silence')), step.hang()]] }]
      }
    })
    await t.send('go quiet')
    await expect(t.panel.getByText('then silence')).toBeVisible()
    // No tool is open, nothing arrives: after the stall bound the agent is stopped.
    await t.run(0, (r) => r.signals().includes('SIGTERM'), 10_000)
    await expect(t.stopButton).toBeHidden({ timeout: 10_000 })
  })

  test('a long, silent tool is not killed by the watchdog', async ({ chat }) => {
    await chat.setWatchdogTimings(FAST_WATCHDOG)
    const BUILD = { command: 'npm test', description: 'Run the test suite', timeout: 600_000 }
    const t = await chat.openTask({
      title: 'Chat long tool',
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(ev.init(), ev.toolUse({ id: 'toolu_long', name: 'Bash', input: BUILD })),
                // A real Bash call is silent until it finishes (no progress events).
                step.sleep(5_000),
                step.emit(
                  ev.toolResult({ toolUseId: 'toolu_long', content: 'all tests passed' }),
                  ev.text('The suite passed.'),
                  ev.result({ text: 'The suite passed.' })
                )
              ]
            ]
          }
        ]
      }
    })
    await t.send('run the tests')
    // Preconditions: the tool call is open (persisted, card shown).
    await expect
      .poll(async () => (await t.events()).some((e) => e.event.kind === 'tool-call'))
      .toBe(true)
    await expect(t.panel.getByText('npm test').first()).toBeVisible()

    // The watchdog judges "stuck" by silence, and a running tool is silent: it
    // kills the turn after the stall bound although Bash may run 10 minutes.
    knownBug({
      audit: '#4',
      fixedBy: '1.6',
      what: 'the watchdog kills a healthy long-running tool'
    })
    await expect(t.panel.getByText('The suite passed.')).toBeVisible({ timeout: 10_000 })
    expect(t.epoch.run(0)?.signals()).toEqual([])
  })
})
