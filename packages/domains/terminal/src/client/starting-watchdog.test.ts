/**
 * Tests for the client's stuck-in-`starting` watchdog verdict.
 */
import { describe, expect, test } from 'vitest'
import {
  startingWatchdogVerdict,
  STARTING_WATCHDOG_INTERVAL_MS,
  STARTING_WATCHDOG_MAX_WAIT_MS
} from './starting-watchdog'

describe('startingWatchdogVerdict', () => {
  // The bug this guards: during a workspace restore an agent can wait on its
  // computer for an agent-start slot for longer than the watchdog interval. The
  // backend still holds it, as `starting`; the old watchdog showed it as dead.
  test('backend holds it live and starting (queued for a slot): keep waiting', () => {
    expect(
      startingWatchdogVerdict({
        exists: true,
        actual: 'starting',
        waitedMs: STARTING_WATCHDOG_INTERVAL_MS
      }),
      'verdict'
    ).toEqual({ kind: 'wait' })
  })

  test('backend moved on (a lost state event): adopt its state', () => {
    expect(
      startingWatchdogVerdict({ exists: true, actual: 'running', waitedMs: 20_000 }),
      'verdict'
    ).toEqual({ kind: 'adopt', state: 'running' })
  })

  test('backend no longer has it: dead', () => {
    expect(
      startingWatchdogVerdict({ exists: false, actual: null, waitedMs: 20_000 }),
      'gone'
    ).toEqual({ kind: 'dead' })
    expect(
      startingWatchdogVerdict({ exists: false, actual: 'starting', waitedMs: 20_000 }),
      'not existing but starting'
    ).toEqual({ kind: 'dead' })
  })

  test('starting for implausibly long: dead (last-resort bound)', () => {
    expect(
      startingWatchdogVerdict({
        exists: true,
        actual: 'starting',
        waitedMs: STARTING_WATCHDOG_MAX_WAIT_MS
      }),
      'verdict'
    ).toEqual({ kind: 'dead' })
  })

  test('backend already reports dead: leave it to the exit event', () => {
    expect(
      startingWatchdogVerdict({ exists: true, actual: 'dead', waitedMs: 20_000 }),
      'verdict'
    ).toEqual({ kind: 'none' })
  })
})
