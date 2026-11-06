// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  answerThreadsPanelKey,
  readAnswerThreadsPanel,
  writeAnswerThreadsPanel
} from './answer-threads-panel'

const panel = { conversationId: 's1', answerId: 'm1:0', sourceMessageId: 'u1', activeId: 't1' }

describe('answer threads panel storage', () => {
  afterEach(() => localStorage.clear())

  it('keys per hub and tab', () => {
    expect(answerThreadsPanelKey('local', 'tab')).not.toBe(answerThreadsPanelKey('hub2', 'tab'))
    expect(answerThreadsPanelKey('local', 'a')).not.toBe(answerThreadsPanelKey('local', 'b'))
  })

  it('round-trips an open panel, including "New thread" (activeId null)', () => {
    const key = answerThreadsPanelKey('local', 'tab')
    writeAnswerThreadsPanel(key, panel)
    expect(readAnswerThreadsPanel(key)).toEqual(panel)
    writeAnswerThreadsPanel(key, { ...panel, activeId: null })
    expect(readAnswerThreadsPanel(key)).toEqual({ ...panel, activeId: null })
  })

  it('closing forgets it', () => {
    const key = answerThreadsPanelKey('local', 'tab')
    writeAnswerThreadsPanel(key, panel)
    writeAnswerThreadsPanel(key, null)
    expect(localStorage.getItem(key)).toBeNull()
    expect(readAnswerThreadsPanel(key)).toBeNull()
  })

  it('ignores malformed entries', () => {
    const key = answerThreadsPanelKey('local', 'tab')
    for (const raw of [
      'not json',
      'null',
      '{}',
      JSON.stringify({ ...panel, answerId: '' }),
      JSON.stringify({ ...panel, activeId: 3 }),
      JSON.stringify({ ...panel, activeId: undefined })
    ]) {
      localStorage.setItem(key, raw)
      expect(readAnswerThreadsPanel(key)).toBeNull()
    }
  })
})
