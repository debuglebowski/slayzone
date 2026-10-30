/**
 * Claude Code chat (chat A): Stop / Esc is a live interrupt. The agent process
 * stays; it is only replaced when the interrupt is not acknowledged. Stop before
 * any output gives the message back and the CLI forgets it (a pending prompt on
 * Stop: 148). The queue gate counts
 * pending prompts (two parallel prompts: one answer does not end "needs you").
 * Against the scripted fake CLI (2.1.312 behaviour, chat-a real-CLI checks R4).
 */
import { resetApp } from '../fixtures/electron'
import { echoTurn, ev, expect, step, test } from '../fixtures/chat'

test.describe('Chat Stop as a live interrupt', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('Stop after output interrupts the turn; the same process answers the next message', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Stop interrupts live',
      scenario: {
        processes: [
          {
            turns: [[step.emit(ev.init(), ev.text('working on it')), step.hang()]],
            defaultTurn: echoTurn()
          }
        ]
      }
    })
    await t.send('a long job')
    await expect(t.panel.getByText('working on it')).toBeVisible()

    await t.stopButton.click()
    await expect(t.sendButton).toBeVisible()
    const run = await t.run(0, (r) => r.controlRequests('interrupt').length === 1)
    await expect
      .poll(async () => (await t.events()).filter((e) => e.event.kind === 'interrupted').length)
      .toBe(1)
    await expect(t.panel.getByText('working on it')).toBeVisible()
    await expect(t.composer).toHaveValue('')

    await t.send('next one')
    await expect(t.panel.getByText('echo: next one')).toBeVisible()
    expect(t.epoch.runs()).toHaveLength(1)
    expect(run.signals()).toEqual([])
  })

  test('Stop before any output gives the message back and the CLI forgets it', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Stop pops and rewinds',
      scenario: { processes: [{ turns: [[step.hang()]], defaultTurn: echoTurn() }] }
    })
    await t.send('a long job')
    const sent = await t.run(0, (r) => r.userMessages().includes('a long job'))
    const uuid = sent.stdin().find((m) => m.type === 'user')?.uuid

    await t.stopButton.click()
    await expect(t.composer).toHaveValue('a long job')
    const run = await t.run(0, (r) => r.rewound().length === 1)
    expect(run.controlRequests().map((r) => r.subtype)).toEqual([
      'interrupt',
      'rewind_conversation'
    ])
    expect(run.rewound()).toEqual([uuid])
    await expect
      .poll(async () =>
        (await t.events()).some(
          (e) => e.event.kind === 'user-message-popped' && e.event.id === uuid
        )
      )
      .toBe(true)

    await t.composer.fill('')
    await t.send('next one')
    await expect(t.panel.getByText('echo: next one')).toBeVisible()
    expect(t.epoch.runs()).toHaveLength(1)
  })

  test('an interrupt the CLI never acknowledges falls back to replacing the process', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Stop falls back',
      scenario: {
        processes: [
          {
            turns: [[step.emit(ev.init(), ev.text('stuck')), step.hang()]],
            controlResponses: { interrupt: 'ignore' }
          },
          { defaultTurn: echoTurn() }
        ]
      }
    })
    await t.send('a long job')
    await expect(t.panel.getByText('stuck')).toBeVisible()

    await t.stopButton.click()
    await t.run(1)
    await expect(t.sendButton).toBeVisible()
    await t.send('next one')
    await expect(t.panel.getByText('echo: next one')).toBeVisible()
  })

  test('two prompts at once: answering one keeps "needs you" and the queue waiting', async ({
    chat,
    electronApp
  }) => {
    const one = { command: 'echo one' }
    const two = { command: 'echo two' }
    const t = await chat.openTask({
      title: 'Two prompts',
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(
                  ev.init(),
                  ev.toolUse({ id: 'tu_one', name: 'Bash', input: one }),
                  ev.toolUse({ id: 'tu_two', name: 'Bash', input: two })
                ),
                step.parallel(
                  [
                    step.request(
                      { tool_name: 'Bash', input: one, tool_use_id: 'tu_one' },
                      { allow: [step.emit(ev.toolResult({ toolUseId: 'tu_one', content: 'one' }))] }
                    )
                  ],
                  [
                    step.request(
                      { tool_name: 'Bash', input: two, tool_use_id: 'tu_two' },
                      { allow: [step.emit(ev.toolResult({ toolUseId: 'tu_two', content: 'two' }))] }
                    )
                  ]
                ),
                step.emit(ev.text('both ran'), ev.result({ text: 'both ran' }))
              ]
            ],
            defaultTurn: echoTurn()
          }
        ]
      }
    })
    const flag = () =>
      electronApp.evaluate(async ({}, id) => {
        const d = (globalThis as Record<string, unknown>).__db as {
          all: (sql: string, params?: unknown[]) => Promise<Array<{ needs_attention: number }>>
        }
        const rows = await d.all('SELECT needs_attention FROM tasks WHERE id = ?', [id])
        return rows[0]?.needs_attention
      }, t.taskId)
    const requestIds = async () =>
      (await t.events())
        .filter((e) => e.event.kind === 'permission-request')
        .map((e) => String(e.event.requestId))
    const allow = (requestId: string) =>
      t.page.evaluate(
        ({ tabId, requestId }) =>
          window.getTrpcVanillaClient().chat.respondPermission.mutate({
            tabId,
            args: { requestId, decision: { behavior: 'allow', updatedInput: {} } }
          }),
        { tabId: t.tabId, requestId }
      )

    await t.send('run both')
    await expect.poll(async () => (await requestIds()).length).toBe(2)
    await expect.poll(flag).toBe(1)
    await t.page.evaluate(
      (tabId) =>
        window.getTrpcVanillaClient().chat.queue.push.mutate({
          tabId,
          send: 'queued meanwhile',
          original: 'queued meanwhile'
        }),
      t.tabId
    )

    const [first, second] = await requestIds()
    expect(await allow(first)).toBe(true)
    await expect
      .poll(async () => (await t.events()).some((e) => e.event.kind === 'tool-result'))
      .toBe(true)
    // The second prompt still waits: the task still needs the user, the queue holds.
    await t.page.waitForTimeout(500)
    expect(await flag()).toBe(1)
    expect((await t.run(0)).userMessages()).toEqual(['run both'])

    expect(await allow(second)).toBe(true)
    await expect(t.panel.getByText('both ran')).toBeVisible()
    await expect(t.panel.getByText('echo: queued meanwhile')).toBeVisible()
  })
})
