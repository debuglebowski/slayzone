import { describe, expect, it } from 'vitest'
import { SentenceChunker, speakable } from './sentence-chunker'
import { NoSpeakGate } from './no-speak'
import { formatInterruptionNote, ReplyPlaybackTracker } from './interruption'

function streamed(text: string, step = 3): string[] {
  const c = new SentenceChunker()
  const out: string[] = []
  for (let i = 0; i < text.length; i += step) out.push(...c.push(text.slice(i, i + step)))
  out.push(...c.flush())
  return out
}

describe('SentenceChunker', () => {
  it('emits a sentence once the whitespace after its terminator arrives', () => {
    const c = new SentenceChunker()
    expect(c.push('Done. The tests')).toEqual(['Done.'])
    expect(c.push(' pass!')).toEqual([])
    expect(c.push(' Next')).toEqual(['The tests pass!'])
    expect(c.flush()).toEqual(['Next'])
  })

  it('does not split file names, decimals or abbreviations', () => {
    expect(
      streamed('I edited index.ts and bumped it to 3.5 today. Also e.g. the docs. Done.')
    ).toEqual(['I edited index.ts and bumped it to 3.5 today.', 'Also e.g. the docs.', 'Done.'])
  })

  it('splits at line breaks and strips markdown', () => {
    expect(streamed('## Summary\n- **Fixed** the `parser`\n- Added [docs](http://x)\n')).toEqual([
      'Summary',
      'Fixed the parser',
      'Added docs'
    ])
  })

  it('drops fenced code blocks', () => {
    expect(streamed('Here it is.\n```ts\nconst a = 1. b\n```\nThat is all.', 4)).toEqual([
      'Here it is.',
      'That is all.'
    ])
  })

  it('cuts a long run-on sentence at a clause break', () => {
    const long = `${'word '.repeat(30)}, ${'more '.repeat(30)}`
    const out = streamed(long, 10)
    expect(out.length).toBeGreaterThan(1)
    for (const s of out) expect(s.length).toBeLessThanOrEqual(220)
  })

  it('speakable is empty for punctuation-only text', () => {
    expect(speakable('---')).toBe('')
    expect(speakable('| a | b |')).toBe('')
  })
})

describe('NoSpeakGate', () => {
  it('silences a message that starts with the token', () => {
    const g = new NoSpeakGate()
    expect(g.push('[no-')).toBe('')
    expect(g.push('speak] long diff')).toBe('')
    expect(g.push(' more')).toBe('')
    expect(g.state).toBe('silent')
  })
  it('tolerates spellings', () => {
    for (const t of ['[No Speak] x', '<nospeak> x', '  [NO_SPEAK] x']) {
      const g = new NoSpeakGate()
      g.push(t)
      expect(g.state).toBe('silent')
    }
  })
  it('passes normal text through without delay', () => {
    const g = new NoSpeakGate()
    expect(g.push('Sure')).toBe('Sure')
    const h = new NoSpeakGate()
    expect(h.push('[1] first')).toBe('[1] first')
  })
  it('releases a short held prefix at the end', () => {
    const g = new NoSpeakGate()
    expect(g.push('[no')).toBe('')
    expect(g.end()).toBe('[no')
  })
})

describe('interruption notes', () => {
  it('names the sentence that was playing', () => {
    const t = new ReplyPlaybackTracker()
    t.begin()
    t.queued('One.')
    t.queued('Two "quoted".')
    t.queued('Three.')
    t.started(1)
    t.finished(1)
    t.started(2)
    const point = t.interrupt()
    expect(point && formatInterruptionNote(point)).toBe(
      `[interrupted during sentence 2: "Two 'quoted'."; later sentences were not heard]`
    )
    expect(t.active()).toBe(false)
  })
  it('between sentences, and before anything was heard', () => {
    const t = new ReplyPlaybackTracker()
    t.begin()
    t.queued('One.')
    t.queued('Two.')
    t.started(1)
    t.finished(1)
    let point = t.interrupt()
    expect(point && formatInterruptionNote(point)).toBe(
      '[interrupted after sentence 1; later sentences were not heard]'
    )
    t.begin()
    t.queued('One.')
    point = t.interrupt()
    expect(point && formatInterruptionNote(point)).toBe(
      '[interrupted before any of the reply was heard]'
    )
  })
  it('the last sentence of a complete reply: no "later sentences"', () => {
    const t = new ReplyPlaybackTracker()
    t.begin()
    t.queued('Only.')
    t.complete()
    t.started(1)
    const point = t.interrupt()
    expect(point && formatInterruptionNote(point)).toBe('[interrupted during sentence 1: "Only."]')
  })
})
