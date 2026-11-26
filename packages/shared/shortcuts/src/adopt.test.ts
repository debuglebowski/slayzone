import { describe, expect, it, vi } from 'vitest'
import { adoptShortcutsFromHub } from './adopt'

const deps = (over: Partial<Parameters<typeof adoptShortcutsFromHub>[0]> = {}) => {
  const write = vi.fn(async (_o: Record<string, string | null>) => undefined)
  return {
    write,
    args: {
      alreadyAdopted: false,
      readHub: async () => JSON.stringify({ 'go-home': 'mod+k' }),
      write,
      ...over
    }
  }
}

describe('adoptShortcutsFromHub (one-time overwrite, D1)', () => {
  it("overwrites the file's stale value with the hub's", async () => {
    const d = deps()
    expect(await adoptShortcutsFromHub(d.args)).toBe('adopted')
    expect(d.write).toHaveBeenCalledWith({ 'go-home': 'mod+k' })
  })

  it('runs once: a set marker skips it', async () => {
    const d = deps({ alreadyAdopted: true })
    expect(await adoptShortcutsFromHub(d.args)).toBe('skipped')
    expect(d.write).not.toHaveBeenCalled()
  })

  it('a failed hub read writes nothing (no marker, retried next boot)', async () => {
    const d = deps({
      readHub: async () => {
        throw new Error('hub down')
      }
    })
    expect(await adoptShortcutsFromHub(d.args)).toBe('failed')
    expect(d.write).not.toHaveBeenCalled()
  })

  it('hub has none (null): adopts an empty map', async () => {
    const d = deps({ readHub: async () => null })
    expect(await adoptShortcutsFromHub(d.args)).toBe('adopted')
    expect(d.write).toHaveBeenCalledWith({})
  })

  it('normalizes the hub value (renames, retired defaults)', async () => {
    const d = deps({
      readHub: async () => JSON.stringify({ 'agent-panel': 'mod+l', 'zen-mode': 'mod+j' })
    })
    await adoptShortcutsFromHub(d.args)
    expect(d.write).toHaveBeenCalledWith({ 'global-agent-panel': 'mod+l' })
  })

  it('unparseable hub value counts as a read failure', async () => {
    const d = deps({ readHub: async () => 'not-json{' })
    expect(await adoptShortcutsFromHub(d.args)).toBe('failed')
    expect(d.write).not.toHaveBeenCalled()
  })

  it('a failed write reports failure (marker rides the same write)', async () => {
    const d = deps({
      write: async () => {
        throw new Error('disk full')
      }
    })
    expect(await adoptShortcutsFromHub(d.args)).toBe('failed')
  })
})
