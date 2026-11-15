import { describe, expect, it, vi } from 'vitest'
import { readTextWithFallback } from './read-text-fallback'

const missing = () => Promise.reject(new Error('No procedure found on path "artifacts.readText"'))

describe('readTextWithFallback', () => {
  it('uses readText when the hub has it', async () => {
    const legacy = vi.fn()
    expect(await readTextWithFallback(async () => ({ kind: 'binary', size: 3 }), legacy)).toEqual({
      kind: 'binary',
      size: 3
    })
    expect(legacy).not.toHaveBeenCalled()
  })

  it('a hub without readText: the old read, as text with its byte size', async () => {
    expect(await readTextWithFallback(missing, async () => 'hé')).toEqual({
      kind: 'text',
      content: 'hé',
      size: 3
    })
    expect(await readTextWithFallback(missing, async () => null)).toBeNull()
  })

  it('any other failure is not hidden', async () => {
    const legacy = vi.fn()
    await expect(
      readTextWithFallback(() => Promise.reject(new Error('computer offline')), legacy)
    ).rejects.toThrow('computer offline')
    expect(legacy).not.toHaveBeenCalled()
  })
})
