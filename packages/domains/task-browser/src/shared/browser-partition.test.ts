import { expect, test } from 'vitest'
import {
  ISOLATED_BROWSER_PARTITION,
  LOCAL_BROWSER_PARTITION,
  WEB_PANEL_PARTITION,
  browserPartitionForHub,
  browserPartitionForTab,
  isBrowserPanelPartition,
  isIsolatedPartition,
  isRemoteUserBrowserPartition,
  isUsersOwnPartition,
  webPanelPartitionForHub
} from './browser-partition'

test('the local hub keeps the existing partition (users keep their logins)', () => {
  expect(browserPartitionForHub('local', true)).toBe('persist:browser-tabs')
  expect(LOCAL_BROWSER_PARTITION).toBe('persist:browser-tabs')
})

test('each remote hub gets its own, stable partition', () => {
  const a = browserPartitionForHub('hub:https://a.example.com', false)
  const b = browserPartitionForHub('hub:https://b.example.com', false)
  expect(a).not.toBe('persist:browser-tabs')
  expect(a).not.toBe(b)
  expect(browserPartitionForHub('hub:https://a.example.com', false)).toBe(a)
  // Hub ids that differ only in punctuation still get different jars.
  expect(browserPartitionForHub('hub:https://a-b.test', false)).not.toBe(
    browserPartitionForHub('hub:https://a.b.test', false)
  )
  expect(isBrowserPanelPartition(a)).toBe(true)
})

test('main accepts only browser-panel partitions', () => {
  expect(isBrowserPanelPartition('persist:browser-tabs')).toBe(true)
  expect(isBrowserPanelPartition('persist:web-panels')).toBe(true)
  for (const p of [
    '',
    'persist:other',
    'browser-tabs',
    'persist:browser-tabs-hub-',
    'persist:browser-tabs-hub-x/../y'
  ]) {
    expect(isBrowserPanelPartition(p)).toBe(false)
  }
})

test("an isolated tab of the local hub never browses in the user's own partition", () => {
  expect(browserPartitionForTab(LOCAL_BROWSER_PARTITION, { isolated: true })).toBe(
    ISOLATED_BROWSER_PARTITION
  )
  expect(browserPartitionForTab(LOCAL_BROWSER_PARTITION, {})).toBe(LOCAL_BROWSER_PARTITION)
  // In memory only: empty at every start, nothing of the user's.
  expect(ISOLATED_BROWSER_PARTITION.startsWith('persist:')).toBe(false)
  expect(isUsersOwnPartition(ISOLATED_BROWSER_PARTITION)).toBe(false)
  expect(isBrowserPanelPartition(ISOLATED_BROWSER_PARTITION)).toBe(true)
  // A remote hub's tabs keep its own (already isolated) partition.
  expect(isIsolatedPartition(ISOLATED_BROWSER_PARTITION)).toBe(true)
  expect(isIsolatedPartition(LOCAL_BROWSER_PARTITION)).toBe(false)
})

test("a remote hub's agent tabs get their own empty jar, not the hub's shared one (review 5)", () => {
  const remote = browserPartitionForHub('hub:https://a.example.com', false)
  const other = browserPartitionForHub('hub:https://b.example.com', false)
  const iso = browserPartitionForTab(remote, { isolated: true })
  // The user's own tabs on that hub keep the hub's persistent partition…
  expect(browserPartitionForTab(remote, {})).toBe(remote)
  expect(isIsolatedPartition(remote)).toBe(false)
  expect(isUsersOwnPartition(remote)).toBe(false)
  // …an agent's tab browses in memory, apart from them and from other hubs' agents.
  expect(iso).not.toBe(remote)
  expect(iso.startsWith('persist:')).toBe(false)
  expect(isIsolatedPartition(iso)).toBe(true)
  expect(isBrowserPanelPartition(iso)).toBe(true)
  expect(browserPartitionForTab(other, { isolated: true })).not.toBe(iso)
  expect(isIsolatedPartition('browser-tabs-isolated-hub-zz')).toBe(false)
})

test("a remote hub's web panels get that hub's own partition, never the trusted shared one (review 6)", () => {
  expect(webPanelPartitionForHub('local', true)).toBe(WEB_PANEL_PARTITION)
  const a = webPanelPartitionForHub('hub:https://a.example.com', false)
  expect(a).toBe('persist:web-panels-hub-3f2d202f-a-example-com')
  expect(webPanelPartitionForHub('hub:https://b.example.com', false)).not.toBe(a)
  expect(isBrowserPanelPartition(a)).toBe(true)
  expect(isUsersOwnPartition(a)).toBe(false)
  expect(isIsolatedPartition(a)).toBe(false)
  expect(isBrowserPanelPartition('persist:web-panels-hub-zz')).toBe(false)
})

test("only the user's own remote-hub tabs may reach local addresses on the user's act (review 6 F2)", () => {
  const remote = browserPartitionForHub('hub:https://a.example.com', false)
  expect(isRemoteUserBrowserPartition(remote)).toBe(true)
  // Never an agent's tab, a web panel, or the local partitions.
  expect(isRemoteUserBrowserPartition(browserPartitionForTab(remote, { isolated: true }))).toBe(
    false
  )
  expect(
    isRemoteUserBrowserPartition(webPanelPartitionForHub('hub:https://a.example.com', false))
  ).toBe(false)
  expect(isRemoteUserBrowserPartition(LOCAL_BROWSER_PARTITION)).toBe(false)
  expect(isRemoteUserBrowserPartition(ISOLATED_BROWSER_PARTITION)).toBe(false)
})
