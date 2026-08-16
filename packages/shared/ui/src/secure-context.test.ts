/**
 * @vitest-environment jsdom
 *
 * `safeRandomUUID` / `safeClipboardWriteText` / `safeClipboardReadText` —
 * the guards a non-secure-context host (the web shell over plain `http://`,
 * a LAN IP dev loop) needs so `crypto.randomUUID()` and the async Clipboard
 * API degrade instead of throwing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { safeClipboardReadText, safeClipboardWriteText, safeRandomUUID } from './secure-context'

describe('safeRandomUUID', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses crypto.randomUUID when available', () => {
    const id = safeRandomUUID()
    // jsdom's crypto.randomUUID is real — a genuine UUID shape.
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('falls back to a non-throwing id when crypto.randomUUID is unavailable', () => {
    // `delete crypto.randomUUID` does NOT work here — jsdom exposes it via
    // the Crypto prototype, so deleting the (nonexistent) own property is a
    // silent no-op and the real method stays reachable. Replacing the whole
    // global is the only way to actually simulate its absence.
    vi.stubGlobal('crypto', {})
    const id = safeRandomUUID()
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  it('fallback ids never collide within a page life', () => {
    vi.stubGlobal('crypto', {})
    const ids = new Set([safeRandomUUID(), safeRandomUUID(), safeRandomUUID()])
    expect(ids.size).toBe(3)
  })
})

describe('safeClipboardWriteText / safeClipboardReadText', () => {
  const originalClipboard = navigator.clipboard

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true
    })
    vi.restoreAllMocks()
  })

  it('writes via navigator.clipboard when available, resolving true', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true
    })
    const ok = await safeClipboardWriteText('hello')
    expect(ok).toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('falls back to the legacy execCommand copy when navigator.clipboard is undefined', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    const execCommand = vi.fn().mockReturnValue(true)
    document.execCommand = execCommand as unknown as typeof document.execCommand
    const ok = await safeClipboardWriteText('hello')
    expect(ok).toBe(true)
    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('falls back to legacy copy when the async write REJECTS (e.g. permission denied)', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true
    })
    const execCommand = vi.fn().mockReturnValue(true)
    document.execCommand = execCommand as unknown as typeof document.execCommand
    const ok = await safeClipboardWriteText('hello')
    expect(ok).toBe(true)
    expect(execCommand).toHaveBeenCalled()
  })

  it('read returns null (not a throw) when navigator.clipboard is undefined', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    await expect(safeClipboardReadText()).resolves.toBeNull()
  })

  it('read returns the clipboard text when available', async () => {
    const readText = vi.fn().mockResolvedValue('pasted!')
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText },
      configurable: true
    })
    await expect(safeClipboardReadText()).resolves.toBe('pasted!')
  })

  it('read returns null (not a throw) when the read REJECTS', async () => {
    const readText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText },
      configurable: true
    })
    await expect(safeClipboardReadText()).resolves.toBeNull()
  })
})
