import { expect, it } from 'vitest'
import { boardLoadPayload } from './board-load-report'

it('encodes the reason as one boolean key a renderer diagnostic keeps', () => {
  expect(boardLoadPayload('default', 'boot')).toEqual({ extraHub: false, boot: true })
  expect(boardLoadPayload('extra', 'unscoped-event')).toEqual({
    extraHub: true,
    unscopedEvent: true
  })
  expect(boardLoadPayload('default', 'patch-fallback:too-many-rows')).toEqual({
    extraHub: false,
    patchFallback_too_many_rows: true
  })
  for (const key of Object.keys(boardLoadPayload('extra', 'parts-fallback:lists-failed')))
    expect(key).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
})
