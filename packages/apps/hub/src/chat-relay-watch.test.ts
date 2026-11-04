/**
 * The hub asks computers for full chat events only for the tabs hub clients watch
 * (docs/direct-link.md); a direct-link client watches its computer, not the hub.
 */
import { expect, test } from 'vitest'
import { createChatRelayWatch } from './chat-relay-watch'

const flush = () => new Promise((r) => setTimeout(r, 0))

function setup(computers = ['c1', 'c2']) {
  const sent: Array<{ computerId: string; all: boolean; tabIds: string[] }> = []
  const watch = createChatRelayWatch({
    computers: () => computers,
    send: async (computerId, config) => {
      sent.push({ computerId, ...config })
    }
  })
  return { watch, sent }
}

test('tells every computer the union of watched tabs, coalesced per tick', async () => {
  const { watch, sent } = setup()
  watch.watch(['b'])
  watch.watch(['a', 'b'])
  await flush()
  expect(sent).toEqual([
    { computerId: 'c1', all: false, tabIds: ['a', 'b'] },
    { computerId: 'c2', all: false, tabIds: ['a', 'b'] }
  ])
})

test('an unfiltered watcher (an older client) means all, until it leaves', async () => {
  const { watch, sent } = setup(['c1'])
  const offAll = watch.watch('all')
  watch.watch(['a'])
  await flush()
  expect(sent.at(-1)).toEqual({ computerId: 'c1', all: true, tabIds: ['a'] })
  offAll()
  await flush()
  expect(sent.at(-1)).toEqual({ computerId: 'c1', all: false, tabIds: ['a'] })
})

test('refcounts: a tab stays watched until its last watcher leaves; unchanged config is not resent', async () => {
  const { watch, sent } = setup(['c1'])
  const one = watch.watch(['a'])
  const two = watch.watch(['a'])
  await flush()
  one()
  await flush()
  expect(sent.length).toBe(1)
  two()
  await flush()
  expect(sent.at(-1)).toEqual({ computerId: 'c1', all: false, tabIds: [] })
})

test('a (re)connected computer gets the current config', async () => {
  const { watch, sent } = setup(['c1'])
  watch.watch(['a'])
  await flush()
  await watch.computerConnected('c9')
  expect(sent.at(-1)).toEqual({ computerId: 'c9', all: false, tabIds: ['a'] })
})
