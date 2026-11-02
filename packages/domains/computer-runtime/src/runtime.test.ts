import { describe, expect, it } from 'vitest'
import { ConnectorLease, RetryPolicy } from './index'

describe('persistent runtime fencing', () => {
  it('fences old connector without disposing its sessions, including rollback', () => {
    const lease = new ConnectorLease()
    expect(lease.claim(1)).toBe(true)
    expect(lease.claim(2)).toBe(true)
    expect(lease.claim(1)).toBe(false)
    expect(lease.isCurrent(1)).toBe(false)
    expect(lease.claim(3)).toBe(true)
  })
  it('quarantines failing targets and clears on target change', () => {
    const retry = new RetryPolicy(() => 0.5)
    expect(retry.fail('v2', 0)).toBe(5000)
    retry.fail('v2', 5000)
    expect(retry.fail('v2', 15000)).toBe(900000)
    expect(retry.ready('v2', 16000)).toBe(false)
    expect(retry.ready('v3', 16000)).toBe(true)
  })
})

it('retains release cooldown after supervisor restart', () => {
  const original = new RetryPolicy(() => 0.5)
  original.quarantine('2.0.0', 1000)
  const resumed = new RetryPolicy(() => 0.5, original.snapshot())
  expect(resumed.ready('2.0.0', 2000)).toBe(false)
  expect(resumed.ready('3.0.0', 2000)).toBe(true)
  expect(resumed.ready('2.0.0', 901000)).toBe(true)
})
