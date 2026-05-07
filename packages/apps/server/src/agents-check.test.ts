import { test, expect, describe } from 'vitest'
import { probeAgents, whichSync, KNOWN_AGENTS } from './agents-check'

describe('agents-check', () => {
  test('probeAgents returns one entry per known agent', () => {
    const results = probeAgents()
    expect(results.length).toBe(KNOWN_AGENTS.length)
    for (const r of results) {
      expect(typeof r.name).toBe('string')
      expect(typeof r.found).toBe('boolean')
      if (r.found) expect(typeof r.path).toBe('string')
      else expect(r.path).toBeNull()
    }
  })

  test('whichSync finds a known executable (node)', () => {
    const path = whichSync('node')
    expect(path).not.toBeNull()
    expect(path?.endsWith('node') || path?.endsWith('node.exe')).toBe(true)
  })

  test('whichSync returns null for non-existent command', () => {
    const path = whichSync('this-command-definitely-does-not-exist-123456')
    expect(path).toBeNull()
  })

  test('probeAgents respects custom env PATH', () => {
    const results = probeAgents(['nonsense'], { PATH: '' })
    expect(results[0].found).toBe(false)
  })
})
