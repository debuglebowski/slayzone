/**
 * A direct-link listener address in one canonical spelling (docs/direct-link.md):
 * the hub issues it and the desktop's gate and CSP compare it, so `box:443` and
 * `box` must be the same address everywhere.
 */
import { describe, expect, it } from 'vitest'
import { normalizeDirectAddress } from './direct-link'

describe('normalizeDirectAddress', () => {
  it("drops the scheme's default port (wss :443 public, ws :80 loopback) and lower-cases the host", () => {
    expect(normalizeDirectAddress('box.example:443')).toBe('box.example')
    expect(normalizeDirectAddress('Box.Example:7443')).toBe('box.example:7443')
    expect(normalizeDirectAddress('box.example:80')).toBe('box.example:80')
    expect(normalizeDirectAddress('127.0.0.1:80')).toBe('127.0.0.1')
    expect(normalizeDirectAddress('127.0.0.1:443')).toBe('127.0.0.1:443')
    expect(normalizeDirectAddress('[::1]:5001')).toBe('[::1]:5001')
  })

  it('refuses anything that is not a bare authority', () => {
    for (const bad of ['', 'ws://box:1', 'box:1/x', '*', 'u@box:1', 'box:1?x', 'box:1#x', 'a b'])
      expect(normalizeDirectAddress(bad), bad).toBeNull()
  })
})
