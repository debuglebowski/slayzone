import { expect, test } from 'vitest'
import { chatAvailabilityMessage } from './computer-chat'

test('unavailable shows the reason the hub knows, without repeating the title', () => {
  expect(
    chatAvailabilityMessage({
      state: 'unavailable',
      computer: { id: 'gone', name: 'Computer' },
      reason:
        'Chat history unavailable. Its computer was removed. Connect a computer that holds this chat to restore it.'
    })
  ).toEqual({
    title: 'Chat history unavailable',
    detail: 'Its computer was removed. Connect a computer that holds this chat to restore it.'
  })
})

test('unavailable without a reason keeps the generic explanation', () => {
  expect(
    chatAvailabilityMessage({ state: 'unavailable', computer: { id: 'pc', name: 'laptop' } })
      ?.detail
  ).toMatch(/^laptop did not return this conversation/)
})
