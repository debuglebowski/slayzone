/**
 * toErrorPayload — what main records for an uncaught exception / unhandled rejection.
 *
 * Beside the raw text (withheld by the chat-privacy filter before it is stored), the
 * payload carries the error's identity, so a withheld rejection is still diagnosable:
 * pilot 2026-11-03 stored three startup rejections as `{}`.
 */
import { describe, expect, test } from 'vitest'
import { toErrorPayload } from './error-payload'

describe('toErrorPayload', () => {
  test('a Node fs error: class, code, syscall and errno beside the raw text', () => {
    const err = Object.assign(
      new Error("ENOENT: no such file or directory, open '/x/app-update.yml'"),
      {
        code: 'ENOENT',
        syscall: 'open',
        errno: -2,
        path: '/x/app-update.yml'
      }
    )
    expect(toErrorPayload(err)).toEqual({
      name: 'Error',
      message: err.message,
      stack: err.stack,
      errorClass: 'Error',
      errorCode: 'ENOENT',
      errorSyscall: 'open',
      errno: -2
    })
  })

  test('a subclass is named by its class', () => {
    class HttpError extends Error {}
    const payload = toErrorPayload(new HttpError('boom'))
    expect(payload.errorClass).toBe('HttpError')
    expect(payload).not.toHaveProperty('errorCode')
  })

  test('a non-Error reason: its type, beside the raw value', () => {
    expect(toErrorPayload('nope')).toEqual({ value: 'nope', reasonType: 'string' })
    expect(toErrorPayload(undefined)).toEqual({ value: undefined, reasonType: 'undefined' })
    expect(toErrorPayload({ code: 'X' })).toEqual({ value: '{"code":"X"}', reasonType: 'object' })
  })
})
