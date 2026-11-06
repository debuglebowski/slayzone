/**
 * analyzePtyInput — what one stdin write means for the session, computed the same
 * way wherever the bytes arrive: the hub (relayed writes) or the computer (direct
 * writes, docs/direct-link.md).
 */
import { describe, expect, it } from 'vitest'
import { analyzePtyInput } from './pty-input'

describe('analyzePtyInput', () => {
  it('accumulates typing and reports nothing until submit-Enter', () => {
    const a = analyzePtyInput('', 'hel')
    expect(a).toEqual({
      buffer: 'hel',
      facts: { esc: false, submitted: null, statusCommand: false }
    })
    const b = analyzePtyInput(a.buffer, 'lo')
    expect(b.buffer).toBe('hello')
    expect(b.facts.submitted).toBeNull()
  })

  it('submits the line on CR and on the kitty CSI-u Enter, and resets the buffer', () => {
    for (const enter of ['\r', '\x1b[13u']) {
      const out = analyzePtyInput('fix it', enter)
      expect(out.buffer).toBe('')
      // The snapshot writePty has always taken: the buffer with the Enter bytes in it.
      expect(out.facts.submitted).toBe(`fix it${enter}`)
    }
  })

  it('reports a whitespace-only submit as submitted (callers decide on trim)', () => {
    expect(analyzePtyInput('  ', '\r').facts.submitted).toBe('  \r')
  })

  it('flags the Esc key, never a mouse report', () => {
    expect(analyzePtyInput('', '\x1b').facts.esc).toBe(true)
    expect(analyzePtyInput('', '\x1b[27u').facts.esc).toBe(true)
    expect(analyzePtyInput('', '\x1b[<35;10;5M').facts.esc).toBe(false)
  })

  it('drops terminal reports from the buffer', () => {
    expect(analyzePtyInput('ab', '\x1b[<35;10;5M\x1b[I').buffer).toBe('ab')
  })

  it('spots the conversation-id command on submit, default /status or the adapter’s', () => {
    expect(analyzePtyInput('/status', '\r').facts.statusCommand).toBe(true)
    expect(analyzePtyInput('/session', '\r', '/session').facts.statusCommand).toBe(true)
    expect(analyzePtyInput('/status', 'x').facts.statusCommand).toBe(false)
  })

  it('splits a write at its submit-Enter: keys typed after it start the next line', () => {
    // One write can carry Enter and what followed it (keys typed while the previous
    // write was in flight are sent together).
    const first = analyzePtyInput('hel', 'lo\rnext')
    expect(first.facts.submitted).toBe('hello\r')
    expect(first.buffer).toBe('next')
    const kitty = analyzePtyInput('', 'a\x1b[13ub')
    expect(kitty.facts.submitted).toBe('a\x1b[13u')
    expect(kitty.buffer).toBe('b')
    // The command check sees only the submitted line.
    expect(analyzePtyInput('', 'hi\r/status').facts.statusCommand).toBe(false)
    // Several Enters: up to the last one is submitted.
    expect(analyzePtyInput('', 'a\rb\rc')).toMatchObject({
      buffer: 'c',
      facts: { submitted: 'a\rb\r' }
    })
  })
})
