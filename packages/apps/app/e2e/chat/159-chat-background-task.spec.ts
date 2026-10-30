/**
 * Claude Code chat background commands (plan 3.9): a `run_in_background` Bash
 * keeps showing live output after its turn ended, its final output is saved,
 * the background-jobs banner tracks it by the CLI's task events, Stop kills it
 * (`stop_task`), and the turn the CLI starts by itself when it finishes renders.
 */
import { resetApp } from '../fixtures/electron'
import { ev, expect, step, taskStep, test } from '../fixtures/chat'

const ticks = (n: number, everyMs: number, firstAtMs: number) =>
  Array.from({ length: n }, (_, i) => ({ atMs: firstAtMs + i * everyMs, text: `tick ${i + 1}\n` }))

test.describe('Chat background commands', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('live output after the turn, final output saved, banner, CLI follow-up turn', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Chat background task',
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(
                  ev.init(),
                  ev.toolUse({
                    id: 'toolu_159',
                    name: 'Bash',
                    input: { command: 'loop', description: 'Loop', run_in_background: true }
                  })
                ),
                taskStep({
                  taskId: 't159',
                  toolUseId: 'toolu_159',
                  description: 'Loop',
                  background: true,
                  output: ticks(3, 1_500, 300),
                  endAtMs: 4_500,
                  afterBackgroundExit: [
                    step.emit(
                      ev.init(),
                      ev.text('The loop finished.'),
                      ev.result({ text: 'The loop finished.' })
                    )
                  ]
                }),
                step.emit(ev.text('STARTED'), ev.result({ text: 'STARTED' }))
              ]
            ]
          }
        ]
      }
    })
    await t.send('loop in the background')
    await expect(t.panel.getByText('STARTED')).toBeVisible({ timeout: 5_000 })

    const card = t.panel.getByTestId('tool-bash')
    await expect(card).toHaveAttribute('data-task-state', 'background', { timeout: 5_000 })
    const live = card.getByTestId('bash-live-output')
    await expect(live).toContainText('tick 1', { timeout: 4_000 })
    await expect(live).toContainText('tick 2', { timeout: 4_000 })

    // The banner lists the job by its task id, running.
    const banner = t.page.getByTestId('background-jobs-banner')
    await expect(banner).toContainText('t159')
    await expect(banner).toContainText('Running')

    // It exits: final output (kept by the CLI) is saved and shown; banner completes.
    await expect(card).toHaveAttribute('data-task-state', 'exited', { timeout: 8_000 })
    await expect(card.getByTestId('bash-output')).toContainText('tick 3')
    await expect(card.getByTestId('bash-output')).toContainText('[exited with code 0]')
    await expect(banner).toContainText('Completed')
    // The turn the CLI started by itself shows up.
    await expect(t.panel.getByText('The loop finished.')).toBeVisible({ timeout: 5_000 })

    await t.reload()
    const after = t.panel.getByTestId('tool-bash')
    await expect(after).toHaveAttribute('data-task-state', 'exited')
    await expect(after.getByTestId('bash-output')).toContainText('[exited with code 0]')
    expect(t.epoch.runs()).toHaveLength(1)
  })

  test('Stop kills a running background command', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Chat stop background task',
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(
                  ev.init(),
                  ev.toolUse({
                    id: 'toolu_159s',
                    name: 'Bash',
                    input: { command: 'serve', description: 'Serve', run_in_background: true }
                  })
                ),
                taskStep({
                  taskId: 't159s',
                  toolUseId: 'toolu_159s',
                  description: 'Serve',
                  background: true,
                  output: ticks(30, 1_000, 200),
                  endAtMs: 60_000
                }),
                step.emit(ev.result({ text: 'serving' }))
              ]
            ]
          }
        ]
      }
    })
    await t.send('serve it')
    const card = t.panel.getByTestId('tool-bash')
    await expect(card.getByTestId('bash-live-output')).toContainText('tick 1', { timeout: 5_000 })
    await card.getByRole('button', { name: 'Stop command' }).click()

    const run = await t.run(0)
    await expect
      .poll(() => run.controlRequests().filter((r) => r.subtype === 'stop_task'))
      .toEqual([{ subtype: 'stop_task', task_id: 't159s' }])
    await expect(card).toHaveAttribute('data-task-state', 'stopped', { timeout: 5_000 })
    await expect(card.getByTestId('bash-output')).toContainText('[killed]', { timeout: 5_000 })
    const banner = t.page.getByTestId('background-jobs-banner')
    await expect(banner).toContainText('Killed')
  })
})
