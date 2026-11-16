import { expect, test } from 'vitest'
import { terminalOnThisDevice } from './terminal-on-this-device'

test('local hub: on this device only when the hub says its own computer runs it', () => {
  const on = (onHubMachine: boolean) =>
    terminalOnThisDevice({
      hubIsLocal: true,
      resolved: { computerId: 'c', onHubMachine },
      myComputerIdOnHub: null
    })
  expect(on(true)).toBe(true)
  expect(on(false)).toBe(false)
})

test('remote hub: on this device only when bound to this device’s computer there', () => {
  const at = (computerId: string | null, mine: string | null) =>
    terminalOnThisDevice({ hubIsLocal: false, resolved: { computerId }, myComputerIdOnHub: mine })
  expect(at('mine', 'mine')).toBe(true)
  expect(at('theirs', 'mine')).toBe(false)
  expect(at(null, 'mine')).toBe(false)
  expect(at('mine', null)).toBe(false)
})
