import { describe, expect, it } from 'vitest'
import { stripTrailingPhrase } from './words'
import { TurnDetector, DEFAULT_TURN_DETECTOR_CONFIG } from './turn-detector'

describe('stripTrailingPhrase', () => {
  it('matches the final word case- and punctuation-insensitively', () => {
    expect(stripTrailingPhrase('Run the tests. Over.', 'over')).toBe('Run the tests.')
    expect(stripTrailingPhrase('run the tests, OVER!', 'over')).toBe('run the tests')
    expect(stripTrailingPhrase('fix it over', 'Over')).toBe('fix it')
  })
  it('needs it to be the final word', () => {
    expect(stripTrailingPhrase('it is over now', 'over')).toBeNull()
    expect(stripTrailingPhrase('the takeover', 'over')).toBeNull()
    expect(stripTrailingPhrase('a take-over', 'over')).toBeNull()
  })
  it('matches multi-word phrases', () => {
    expect(stripTrailingPhrase('delete it. Scratch that.', 'scratch that')).toBe('delete it.')
    expect(stripTrailingPhrase('scratch, that', 'scratch that')).toBe('')
    expect(stripTrailingPhrase('that', 'scratch that')).toBeNull()
  })
})

function detector() {
  return new TurnDetector({ ...DEFAULT_TURN_DETECTOR_CONFIG })
}

function say(d: TurnDetector, text: string, endAt: number, transcribedAt = endAt + 150) {
  d.speechStarted()
  d.speechEnded(endAt)
  d.transcript(text, transcribedAt)
}

describe('TurnDetector', () => {
  it('ends the turn on the keyword after 300 ms of silence', () => {
    const d = detector()
    say(d, 'Open the board.', 1000)
    say(d, 'Then run the tests, over.', 3000, 3200)
    expect(d.tick(3250).kind).toBe('none')
    const end = d.tick(3300)
    expect(end).toEqual({
      kind: 'end',
      text: 'Open the board. Then run the tests',
      reason: 'keyword',
      speechEndedAt: 3000,
      transcribedAt: 3200
    })
    expect(d.isMidTurn()).toBe(false)
  })

  it('does not fire while speech continues or a transcript is pending', () => {
    const d = detector()
    say(d, 'the game is over', 1000)
    d.speechStarted()
    expect(d.tick(2000).kind).toBe('none')
    d.speechEnded(2500)
    expect(d.tick(3000).kind).toBe('none') // transcript of segment 2 not back
    d.transcript('and then we restart', 3010)
    expect(d.tick(3100).kind).toBe('none')
  })

  it('a long pause mid-thought does not end the turn before the fallback', () => {
    const d = detector()
    say(d, 'so I was thinking', 1000)
    expect(d.tick(1000 + 7999).kind).toBe('none')
  })

  it('fallback: tone after 8 s of silence, end 2 s later', () => {
    const d = detector()
    say(d, 'refactor the parser', 1000)
    expect(d.tick(9000).kind).toBe('tone')
    expect(d.tick(10_999).kind).toBe('none')
    const end = d.tick(11_000)
    expect(end.kind === 'end' && end.reason).toBe('timeout')
    expect(end.kind === 'end' && end.text).toBe('refactor the parser')
  })

  it('speaking after the tone cancels the timeout', () => {
    const d = detector()
    say(d, 'refactor the parser', 1000)
    expect(d.tick(9000).kind).toBe('tone')
    say(d, 'and the lexer', 9500)
    expect(d.tick(11_500).kind).toBe('none')
  })

  it('"scratch that" discards the buffer', () => {
    const d = detector()
    say(d, 'delete the branch', 1000)
    say(d, 'no wait, scratch that.', 2000)
    expect(d.tick(2400)).toEqual({ kind: 'discard' })
    expect(d.isMidTurn()).toBe(false)
    expect(d.text()).toBe('')
  })

  it('the keyword alone sends nothing', () => {
    const d = detector()
    say(d, 'Over.', 1000)
    expect(d.tick(1400).kind).toBe('none')
    expect(d.isMidTurn()).toBe(false)
  })

  it('uses a configured keyword', () => {
    const d = new TurnDetector({ ...DEFAULT_TURN_DETECTOR_CONFIG, endKeyword: 'go ahead' })
    say(d, 'ship it, over', 1000)
    expect(d.tick(1400).kind).toBe('none')
    say(d, 'go ahead', 2000)
    const end = d.tick(2400)
    expect(end.kind === 'end' && end.text).toBe('ship it, over')
  })
})
