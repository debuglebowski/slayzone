/** Computer seeding preserves order and bounds every authenticated RPC frame. */
import { expect, test } from 'vitest'
import { chatEventSeedBatches, SEED_LIMITS } from './chat-seed.js'

test('empty history still bootstraps the computer owner', () => {
  expect([...chatEventSeedBatches('tab', [])]).toEqual([{ tabId: 'tab', fromSeq: 0, events: [] }])
})

test('every event lands once, at seq = its index, quotes intact', () => {
  const events = Array.from({ length: 2500 }, (_, i) => ({
    kind: 'assistant-text',
    text: `it's #${i}`
  }))
  let seq = 0
  for (const batch of chatEventSeedBatches('tab', events)) {
    expect(batch.tabId).toBe('tab')
    expect(batch.fromSeq).toBe(seq)
    expect(batch.events.length).toBeLessThanOrEqual(SEED_LIMITS.maxEvents)
    expect(batch.events).toEqual(events.slice(seq, seq + batch.events.length))
    seq += batch.events.length
  }
  expect(seq).toBe(events.length)
})

test('10,000 events of 64 KiB: frames stay bounded without collecting a 640 MB request', () => {
  const text = 'x'.repeat(64 * 1024)
  const events = Array.from({ length: 10_000 }, (_, i) => ({ kind: 'tool-result', i, text }))
  let seq = 0,
    batches = 0
  for (const batch of chatEventSeedBatches('tab', events)) {
    expect(batch.fromSeq).toBe(seq)
    expect(batch.events.length).toBeLessThanOrEqual(SEED_LIMITS.maxEvents)
    expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThan(8 * 1024 * 1024)
    seq += batch.events.length
    batches++
  }
  expect(seq).toBe(events.length)
  expect(batches).toBeGreaterThan(1)
}, 120_000)

test('oversize events fail explicitly; UTF-8 bytes determine the limit', () => {
  expect(() => [
    ...chatEventSeedBatches('tab', [
      { kind: 'result', text: 'x'.repeat(SEED_LIMITS.maxBatchBytes) }
    ])
  ]).toThrow(/byte limit/)
  expect(() => [
    ...chatEventSeedBatches('tab', [
      { kind: 'result', text: '界'.repeat(SEED_LIMITS.maxBatchBytes / 2) }
    ])
  ]).toThrow(/byte limit/)
  expect(() => [...chatEventSeedBatches('tab', [{ text: 'missing kind' }])]).toThrow(/kind/)
})

test('frames pack to the count limit when bytes permit', () => {
  const events = Array.from({ length: 3001 }, () => ({ kind: 'notice', text: 'small' }))
  expect([...chatEventSeedBatches('tab', events)].map((b) => b.events.length)).toEqual([
    1000, 1000, 1000, 1
  ])
})
