import { describe, it, expect } from 'vitest'
import { domainTxnRegistry, assertNoDuplicateTxnKeys } from './index'

describe('domainTxnRegistry', () => {
  it('contains the core task/tag/project mutation txns the sidecar dispatches', () => {
    // Spot-check one key per contributing domain — a missing spread (runtime)
    // with an intact type intersection would otherwise only fail in the field.
    for (const key of Object.keys(domainTxnRegistry)) {
      expect(typeof domainTxnRegistry[key as keyof typeof domainTxnRegistry]).toBe('function')
    }
    const prefixes = ['task:', 'tags:', 'projects:', 'automations:']
    for (const prefix of prefixes) {
      expect(
        Object.keys(domainTxnRegistry).some((k) => k.startsWith(prefix)),
        `no txn key with prefix "${prefix}"`
      ).toBe(true)
    }
  })

  it('assertNoDuplicateTxnKeys throws on a cross-source duplicate', () => {
    expect(() => assertNoDuplicateTxnKeys([{ a: 1, b: 2 }, { b: 3 }])).toThrow(
      /Duplicate named transaction key/
    )
    expect(() => assertNoDuplicateTxnKeys([{ a: 1 }, { b: 2 }])).not.toThrow()
  })
})
