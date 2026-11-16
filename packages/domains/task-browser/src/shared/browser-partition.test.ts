import { expect, test } from 'vitest'
import {
  LOCAL_BROWSER_PARTITION,
  browserPartitionForHub,
  isBrowserPanelPartition
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
