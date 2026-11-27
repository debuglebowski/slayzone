/**
 * Every client notices when a hub's DATA was replaced (a backup restore), from the
 * opaque `dataGeneration` in `hub.describe`, and reloads — whoever restored it, any
 * user, desktop or web. A plain restart (same generation) and a hub older than the
 * field change nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { noteDataGeneration, watchHubDataGeneration } from './hubDataGeneration'

afterEach(() => vi.useRealTimers())

describe('noteDataGeneration', () => {
  it('reports a change only after a generation was already seen', () => {
    const client = {}
    expect(noteDataGeneration(client, { dataGeneration: 'a' })).toBe(false)
    expect(noteDataGeneration(client, { dataGeneration: 'a' })).toBe(false)
    expect(noteDataGeneration(client, { dataGeneration: 'b' })).toBe(true)
  })

  it('an older hub (no field) is never a change', () => {
    const client = {}
    expect(noteDataGeneration(client, {})).toBe(false)
    expect(noteDataGeneration(client, { dataGeneration: 'a' })).toBe(false)
    expect(noteDataGeneration(client, null)).toBe(false)
  })
})

describe('watchHubDataGeneration', () => {
  it('asks again on an interval and calls onReplaced once the generation changes', async () => {
    vi.useFakeTimers()
    let generation = 'g1'
    const query = vi.fn(async () => ({ dataGeneration: generation }))
    const onReplaced = vi.fn()
    const stop = watchHubDataGeneration({
      client: { hub: { describe: { query } } },
      onReplaced,
      intervalMs: 1_000
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(query).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(onReplaced).not.toHaveBeenCalled()
    generation = 'g2'
    await vi.advanceTimersByTimeAsync(1_000)
    expect(onReplaced).toHaveBeenCalledTimes(1)
    stop()
    generation = 'g3'
    await vi.advanceTimersByTimeAsync(5_000)
    expect(onReplaced).toHaveBeenCalledTimes(1)
  })

  it('a hub that cannot answer (restarting) is retried, not a change', async () => {
    vi.useFakeTimers()
    let down = false
    const query = vi.fn(async () => {
      if (down) throw new Error('socket closed')
      return { dataGeneration: 'g1' }
    })
    const onReplaced = vi.fn()
    const stop = watchHubDataGeneration({
      client: { hub: { describe: { query } } },
      onReplaced,
      intervalMs: 1_000
    })
    await vi.advanceTimersByTimeAsync(0)
    down = true
    await vi.advanceTimersByTimeAsync(3_000)
    down = false
    await vi.advanceTimersByTimeAsync(1_000)
    expect(onReplaced).not.toHaveBeenCalled()
    stop()
  })
})
