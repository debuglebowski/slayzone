/**
 * Claude Code chat live command output (plan 3.9): once the CLI reports a running
 * Bash as a task (`system/task_started`), its card polls `get_task_output` and
 * shows the output growing with an elapsed timer; polling stops on the tool
 * result and while the tab is hidden. The command is a command task, never a
 * sub-agent row. "Move to background" hands a running command to the background.
 * Fake CLI tasks: packages/shared/test-utils/fake-claude/README.md (tasks.ts).
 */
import { resetApp, seed, openTaskById } from '../fixtures/electron'
import { type ChatTask, ev, expect, step, taskStep, test } from '../fixtures/chat'

const bash = (id: string, command: string, extra: Record<string, unknown> = {}) =>
  step.emit(ev.toolUse({ id, name: 'Bash', input: { command, description: 'Ticks', ...extra } }))

const ticks = (n: number, everyMs: number, firstAtMs: number) =>
  Array.from({ length: n }, (_, i) => ({ atMs: firstAtMs + i * everyMs, text: `tick ${i + 1}\n` }))

async function polls(t: ChatTask): Promise<number> {
  return (await t.run(0)).controlRequests().filter((r) => r.subtype === 'get_task_output').length
}

test.describe('Chat live command output', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('a running Bash shows its output growing and a timer; polls stop at the result', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Chat live output',
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(ev.init()),
                bash('toolu_158', 'for i in 1 2 3; do echo tick $i; sleep 2; done'),
                taskStep({
                  taskId: 't158',
                  toolUseId: 'toolu_158',
                  description: 'Ticks',
                  startAfterMs: 400,
                  output: ticks(3, 2_000, 600),
                  endAtMs: 5_600
                }),
                step.emit(ev.text('Ticks done.'), ev.result({ text: 'Ticks done.' }))
              ]
            ]
          }
        ]
      }
    })
    await t.send('tick please')
    const card = t.panel.getByTestId('tool-bash')
    await expect(card).toHaveAttribute('data-task-state', 'running', { timeout: 5_000 })
    const live = card.getByTestId('bash-live-output')
    await expect(live).toContainText('tick 1', { timeout: 4_000 })
    await expect(live).toContainText('tick 2', { timeout: 4_000 })
    expect(await live.textContent()).not.toContain('tick 3')

    // The elapsed timer runs.
    const elapsed = card.getByTestId('bash-elapsed')
    const first = Number((await elapsed.textContent())?.replace(/\D/g, ''))
    await expect
      .poll(async () => Number((await elapsed.textContent())?.replace(/\D/g, '')), {
        timeout: 4_000
      })
      .toBeGreaterThan(first)

    // The tool result replaces the live output with the final one.
    await expect(t.panel.getByText('Ticks done.')).toBeVisible({ timeout: 8_000 })
    await expect(card).toHaveAttribute('data-task-state', 'exited')
    await expect(card.getByTestId('bash-output')).toContainText('tick 3')
    await expect(live).toHaveCount(0)

    // The card polled the CLI with the task id while it ran — and stops after.
    const run = await t.run(0)
    const requests = run.controlRequests().filter((r) => r.subtype === 'get_task_output')
    expect(requests.length).toBeGreaterThan(1)
    expect(requests.every((r) => r.task_id === 't158')).toBe(true)
    const atResult = await polls(t)
    await t.page.waitForTimeout(2_500)
    expect(await polls(t)).toBe(atResult)

    // A Bash task is a command task, not a sub-agent.
    await expect(t.panel.getByTestId('sub-agent-row')).toHaveCount(0)
    const kinds = (await t.events()).map((e) => e.event.kind)
    expect(kinds).not.toContain('sub-agent')
    expect(kinds).toContain('command-task')
  })

  test('polling pauses while the chat tab is hidden and resumes when shown', async ({
    chat,
    mainWindow
  }) => {
    const t = await chat.openTask({
      title: 'Chat live output hidden',
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(ev.init()),
                bash('toolu_158h', 'long'),
                taskStep({
                  taskId: 't158h',
                  toolUseId: 'toolu_158h',
                  startAfterMs: 300,
                  output: ticks(9, 1_000, 400),
                  endAtMs: 13_000
                }),
                step.emit(ev.text('over'), ev.result({ text: 'over' }))
              ]
            ]
          }
        ]
      }
    })
    await t.send('long one')
    const live = t.panel.getByTestId('tool-bash').getByTestId('bash-live-output')
    await expect(live).toContainText('tick 1', { timeout: 5_000 })

    // Show another task: this chat tab is hidden now.
    const s = seed(mainWindow)
    const project = await s.createProject({ name: 'Chat 158 other', color: '#a3e635' })
    const other = await s.createTask({ projectId: project.id, title: 'Other task', status: 'todo' })
    await s.refreshData()
    await openTaskById(mainWindow, other.id)
    await mainWindow.waitForTimeout(1_200)
    const hiddenAt = await polls(t)
    await mainWindow.waitForTimeout(2_500)
    expect(await polls(t)).toBe(hiddenAt)

    // Back: polling resumes.
    await openTaskById(mainWindow, t.taskId)
    await expect.poll(() => polls(t), { timeout: 4_000 }).toBeGreaterThan(hiddenAt)
    await expect(t.panel.getByText('over')).toBeVisible({ timeout: 12_000 })
  })

  test('Move to background: the turn goes on, the output keeps coming, the final output stays', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Chat move to background',
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(ev.init()),
                bash('toolu_158m', 'slow build'),
                taskStep({
                  taskId: 't158m',
                  toolUseId: 'toolu_158m',
                  startAfterMs: 300,
                  output: ticks(4, 1_500, 400),
                  endAtMs: 7_000
                }),
                step.emit(ev.text('Moved on.'), ev.result({ text: 'Moved on.' }))
              ]
            ]
          }
        ]
      }
    })
    await t.send('build slowly')
    const card = t.panel.getByTestId('tool-bash')
    await expect(card).toHaveAttribute('data-task-state', 'running', { timeout: 5_000 })
    await card.getByRole('button', { name: 'Move to background' }).click()

    const run = await t.run(0)
    await expect
      .poll(() => run.controlRequests().filter((r) => r.subtype === 'background_tasks'))
      .toEqual([{ subtype: 'background_tasks', tool_use_id: 'toolu_158m' }])
    await expect(card).toHaveAttribute('data-task-state', 'background', { timeout: 5_000 })
    await expect(t.panel.getByText('Moved on.')).toBeVisible({ timeout: 5_000 })
    // Still live after the turn ended.
    await expect(card.getByTestId('bash-live-output')).toContainText('tick 3', { timeout: 6_000 })
    // It exits on its own; its final output is saved (survives a reload).
    await expect(card).toHaveAttribute('data-task-state', 'exited', { timeout: 8_000 })
    await expect(card.getByTestId('bash-output')).toContainText('tick 4')
    const saved = (await t.events()).filter((e) => e.event.kind === 'command-task-output')
    expect(saved).toHaveLength(1)
    expect(saved[0].event.output).toContain('[exited with code 0]')
    await t.reload()
    await expect(t.panel.getByTestId('tool-bash').getByTestId('bash-output')).toContainText(
      'tick 4'
    )
  })
})
