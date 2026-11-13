import { expect, test } from 'vitest'
import {
  CHAT_UNAVAILABLE_TITLE,
  chatAvailabilityMessage,
  chatUnavailableDetail,
  chatUnavailableMessage
} from './computer-chat'

test('unavailable explains its reason code; the title is never repeated', () => {
  expect(
    chatAvailabilityMessage({
      state: 'unavailable',
      computer: { id: 'gone', name: 'Computer' },
      reason: chatUnavailableDetail('computer-removed'),
      reasonCode: 'computer-removed'
    })
  ).toEqual({
    title: 'Chat history unavailable',
    detail:
      'Its computer was removed. Connect a computer that holds this chat (e.g. the same machine re-enrolled with its chat data) to restore it.'
  })
  expect(
    chatAvailabilityMessage({
      state: 'unavailable',
      computer: { id: 'pc', name: 'laptop' },
      reasonCode: 'not-returned'
    })?.detail
  ).toMatch(/^laptop did not return this conversation/)
})

test('a hub without reason codes: its title-free reason is shown as sent, else the generic one', () => {
  expect(
    chatAvailabilityMessage({
      state: 'unavailable',
      computer: { id: 'gone', name: 'Computer' },
      reason: 'Its computer was removed.'
    })?.detail
  ).toBe('Its computer was removed.')
  expect(
    chatAvailabilityMessage({ state: 'unavailable', computer: { id: 'pc', name: 'laptop' } })
      ?.detail
  ).toMatch(/^laptop did not return this conversation/)
})

test('as an error: the title, then the detail (the removed text as before v215)', () => {
  expect(chatUnavailableMessage('computer-removed')).toBe(
    'Chat history unavailable. Its computer was removed. Connect a computer that holds this chat (e.g. the same machine re-enrolled with its chat data) to restore it.'
  )
  expect(chatUnavailableMessage('not-returned')).toBe(
    `${CHAT_UNAVAILABLE_TITLE}. ${chatUnavailableDetail('not-returned')}`
  )
})
