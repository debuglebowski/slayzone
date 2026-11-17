import { describe, expect, it } from 'vitest'
import { isBenignWindowError } from './benignWindowError'

describe('isBenignWindowError', () => {
  it('treats the ResizeObserver loop notification as benign (Chromium wording)', () => {
    expect(
      isBenignWindowError({
        message: 'ResizeObserver loop completed with undelivered notifications.',
        error: null
      })
    ).toBe(true)
  })

  it('treats the older ResizeObserver loop wording as benign', () => {
    expect(
      isBenignWindowError({ message: 'ResizeObserver loop limit exceeded', error: null })
    ).toBe(true)
  })

  it('keeps a real thrown error, even one mentioning ResizeObserver', () => {
    expect(
      isBenignWindowError({
        message:
          'Uncaught TypeError: ResizeObserver loop completed with undelivered notifications.',
        error: new TypeError('x')
      })
    ).toBe(false)
  })

  it('keeps ordinary errors', () => {
    expect(isBenignWindowError({ message: 'Uncaught Error: boom', error: new Error('boom') })).toBe(
      false
    )
    expect(isBenignWindowError({ message: '', error: null })).toBe(false)
  })
})
