/**
 * `/btw` side questions: answered aside from the conversation — while a turn
 * runs too — shown in the side card, never in the transcript, never queued.
 * Claude Code: the `side_question` control request (2.1.316), against the
 * scripted fake CLI. Codex: 200-chat-codex-btw.spec.ts.
 */
import { resetApp } from '../fixtures/electron'
import { ev, expect, step, test } from '../fixtures/chat'

test.describe('Chat /btw side questions (Claude Code)', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('mid-turn: answered in the side card; the turn, the queue and the transcript stay as they are', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'btw mid-turn',
      scenario: {
        processes: [
          {
            turns: [[step.emit(ev.init(), ev.text('working on it')), step.hang()]],
            sideQuestion: { reply: 'You asked for a long job.' }
          }
        ]
      }
    })
    await t.send('a long job')
    await expect(t.panel.getByText('working on it')).toBeVisible()

    await t.send('/btw what did I ask?')
    const card = t.panel.getByTestId('side-question-card')
    await expect(card.getByText('You asked for a long job.')).toBeVisible()
    await expect(card.getByText('/btw what did I ask?')).toBeVisible()
    // Same column as the composer it docks onto.
    const cardBox = await card.boundingBox()
    const composerBox = await t.panel.getByTestId('chat-composer-column').boundingBox()
    expect(cardBox?.width).toBeCloseTo(composerBox?.width ?? 0, 0)
    expect(cardBox?.x).toBeCloseTo(composerBox?.x ?? 0, 0)
    await expect(t.composer).toHaveValue('')
    const run = await t.run(0, (r) => r.controlRequests('side_question').length === 1)
    expect(run.controlRequests('side_question')[0]).toEqual({
      subtype: 'side_question',
      question: 'what did I ask?'
    })
    // Not sent, not queued, nothing stopped; the turn still runs.
    expect(run.userMessages()).toEqual(['a long job'])
    expect(run.controlRequests('interrupt')).toEqual([])
    await expect(t.panel.getByTestId('chat-queue-list')).toHaveCount(0)
    await expect(t.stopButton).toBeVisible()
    // Never part of the conversation.
    const saved = JSON.stringify(await t.events())
    expect(saved).not.toContain('what did I ask?')
    expect(saved).not.toContain('You asked for a long job.')

    // A follow-up carries the earlier exchange.
    await t.send('/btw and then?')
    await expect(card.getByTestId('side-question-exchange')).toHaveCount(2)
    const followUp = await t.run(0, (r) => r.controlRequests('side_question').length === 2)
    expect(followUp.controlRequests('side_question')[1]).toEqual({
      subtype: 'side_question',
      question: 'and then?',
      history: [{ question: 'what did I ask?', response: 'You asked for a long job.' }]
    })

    // Esc closes the card — not the turn.
    await expect(card.getByTestId('side-question-answer').last()).toHaveAttribute(
      'data-status',
      'answered'
    )
    await t.composer.press('Escape')
    await expect(card).toHaveCount(0)
    await expect(t.stopButton).toBeVisible()
    expect((await t.run(0)).controlRequests('interrupt')).toEqual([])
  })

  test('closing the card while a question still runs cancels it', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'btw cancel',
      scenario: {
        processes: [
          {
            turns: [[step.emit(ev.init(), ev.text('idle answer'))]],
            sideQuestion: { hang: true }
          }
        ]
      }
    })
    await t.send('hello')
    await expect(t.panel.getByText('idle answer')).toBeVisible()
    await t.send('/btw slow one?')
    const card = t.panel.getByTestId('side-question-card')
    await expect(card.getByText('Thinking…')).toBeVisible()
    const asked = await t.run(0, (r) => r.controlRequests('side_question').length === 1)
    const requestId = asked
      .stdin()
      .find(
        (m) =>
          m.type === 'control_request' &&
          (m.request as { subtype?: string }).subtype === 'side_question'
      )?.request_id

    await card.getByTestId('side-question-close').click()
    await expect(card).toHaveCount(0)
    const run = await t.run(0, (r) =>
      r.stdin().some((m) => m.type === 'control_cancel_request' && m.request_id === requestId)
    )
    expect(run.userMessages()).toEqual(['hello'])
  })

  test('/btw from the menu parks the command; Enter without a question sends nothing', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'btw bare',
      scenario: { processes: [{ turns: [[step.emit(ev.init(), ev.text('hi back'))]] }] }
    })
    await t.send('hi')
    await expect(t.panel.getByText('hi back')).toBeVisible()
    // Enter with the `/` menu open picks the builtin: it parks `/btw `, its hint after it.
    await t.send('/btw')
    await expect(t.composer).toHaveValue('/btw ')
    await t.composer.press('Enter')
    await expect(t.page.getByText('Type a question after /btw')).toBeVisible()
    await expect(t.panel.getByTestId('side-question-card')).toHaveCount(0)
    const run = await t.run(0)
    expect(run.userMessages()).toEqual(['hi'])
    expect(run.controlRequests('side_question')).toEqual([])
  })
})
