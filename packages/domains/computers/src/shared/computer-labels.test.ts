import { describe, expect, it } from 'vitest'
import {
  capabilityNote,
  computerName,
  computerRowStatus,
  computerStatus,
  computerUpgradeTitle,
  inheritComputerLabel,
  NO_COMPUTERS_NOTE,
  OFFLINE_MARK,
  outdatedComputerNote,
  runsOnLabel,
  STANDARD_COMPUTER_CAPABILITIES
} from './computer-labels'

describe('computerStatus', () => {
  it('reports a revoked computer as revoked, whatever its socket says', () => {
    expect(computerStatus({ connected: true, usable: true, lastSeenAt: 1, revokedAt: 2 })).toEqual({
      label: 'Revoked',
      tone: 'bad'
    })
  })

  it('reports a disabled computer as disabled, connected or not', () => {
    for (const connected of [true, false]) {
      expect(
        computerStatus({ connected, usable: connected, lastSeenAt: 1, disabledAt: 2 })
      ).toEqual({ label: 'Disabled', tone: 'idle' })
    }
    // Revoked still outranks it: the credential is gone.
    expect(
      computerStatus({ connected: false, lastSeenAt: 1, disabledAt: 2, revokedAt: 3 }).label
    ).toBe('Revoked')
  })

  it('is Connected only while the computer can take work', () => {
    expect(computerStatus({ connected: true, usable: true, lastSeenAt: 1 })).toEqual({
      label: 'Connected',
      tone: 'ok'
    })
    expect(computerStatus({ connected: true, usable: false, lastSeenAt: 1 })).toEqual({
      label: 'Not responding',
      tone: 'bad'
    })
  })

  it('tells a computer that never connected from one that went offline', () => {
    expect(computerStatus({ connected: false, lastSeenAt: null })).toEqual({
      label: 'Never connected',
      tone: 'idle'
    })
    const seen = Date.UTC(2026, 9, 30, 9, 15)
    expect(computerStatus({ connected: false, usable: false, lastSeenAt: seen })).toEqual({
      label: `Offline · last seen ${new Date(seen).toLocaleString()}`,
      tone: 'idle'
    })
  })
})

describe('computerName', () => {
  const computers = [
    { id: 'c1', name: 'mac-mini' },
    { id: 'c2', name: 'build-box' }
  ]

  it('names a listed computer', () => {
    expect(computerName(computers, 'c2')).toBe('build-box')
  })

  it('calls no computer Local and an unlisted one Unknown computer', () => {
    expect(computerName(computers, null)).toBe('Local')
    expect(computerName(computers, 'gone')).toBe('Unknown computer')
  })
})

describe('choice labels', () => {
  it('names the inherit option after the project default', () => {
    expect(inheritComputerLabel('Local')).toBe('Inherit project default (Local)')
  })

  it('says where a task runs, and that a hub without computers runs it itself', () => {
    expect(runsOnLabel('mac-mini')).toBe('Runs on mac-mini')
    expect(NO_COMPUTERS_NOTE).toBe('No computers — runs locally')
  })

  it('marks a computer that cannot take work now', () => {
    expect(OFFLINE_MARK).toBe('offline')
  })
})

describe('outdatedComputerNote', () => {
  it('a computer older than confirmed chat writes (< 0.36.3): which one, why, what to do', () => {
    expect(outdatedComputerNote({ name: 'linux-box', version: '0.36.2' })).toBe(
      'linux-box runs SlayZone 0.36.2: messages to chat agents on it are not confirmed, so one lost on the way is not noticed. Update the SlayZone CLI on that machine, then run `slay computer restart linux-box`.'
    )
    expect(outdatedComputerNote({ name: 'a', version: '0.35.9' })).not.toBeNull()
    expect(outdatedComputerNote({ name: 'a', version: 'v0.36.2-beta.4' })).not.toBeNull()
  })

  it('none for a computer that confirms writes, or one whose version is unknown', () => {
    for (const version of ['0.36.3', '0.36.10', '0.37.0', '1.0.0', '0.36.3-beta.1']) {
      expect(outdatedComputerNote({ name: 'a', version })).toBeNull()
    }
    for (const version of [null, undefined, '', 'dev', 'x.y.z']) {
      expect(outdatedComputerNote({ name: 'a', version })).toBeNull()
    }
  })
})

describe('computerRowStatus', () => {
  const live = { connected: true, usable: true, lastSeenAt: 1 }
  const upgrade = (phase: string, extra: Record<string, unknown> = {}) =>
    ({ phase, currentVersion: '0.36.4', hostVersion: '0.37.0', updatedAt: 'x', ...extra }) as never

  it('is the plain connection status when no upgrade is in flight', () => {
    expect(computerRowStatus({ ...live })).toEqual({ label: 'Connected', tone: 'ok' })
    expect(computerRowStatus({ ...live, upgradeStatus: upgrade('connected') })).toEqual({
      label: 'Connected',
      tone: 'ok'
    })
    expect(computerRowStatus({ ...live, upgradeStatus: upgrade('checking') })).toEqual({
      label: 'Connected',
      tone: 'ok'
    })
  })

  it('names the step and target while an upgrade runs', () => {
    expect(
      computerRowStatus({ ...live, upgradeStatus: upgrade('installing', { target: '0.37.0' }) })
    ).toEqual({ label: 'Upgrading', detail: 'Installing 0.37.0', tone: 'ok' })
    expect(
      computerRowStatus({
        ...live,
        upgradeStatus: upgrade('waiting-for-idle', { target: '0.37.0' })
      })
    ).toEqual({ label: 'Upgrading', detail: '0.37.0 · waiting for idle', tone: 'ok' })
    expect(
      computerRowStatus({ ...live, upgradeStatus: upgrade('restarting', { target: '0.37.0' }) })
    ).toEqual({ label: 'Upgrading', detail: 'Restarting into 0.37.0', tone: 'ok' })
    expect(
      computerRowStatus({ ...live, upgradeStatus: upgrade('probation', { target: '0.37.0' }) })
    ).toEqual({ label: 'Upgrading', detail: 'Verifying 0.37.0', tone: 'ok' })
  })

  it('flags a failed, rolled-back or blocked upgrade', () => {
    const at = Date.UTC(2026, 10, 4, 14, 32)
    expect(
      computerRowStatus({
        ...live,
        upgradeStatus: upgrade('failed', { target: '0.37.0', retryAt: at, error: 'EACCES' })
      })
    ).toEqual({
      label: 'Upgrade failed',
      detail: `0.37.0 · retry ${new Date(at).toLocaleTimeString()}`,
      tone: 'bad'
    })
    expect(
      computerRowStatus({ ...live, upgradeStatus: upgrade('failed', { target: 'discovery' }) })
    ).toEqual({ label: 'Update check failed', tone: 'bad' })
    expect(
      computerRowStatus({ ...live, upgradeStatus: upgrade('rollback', { target: '0.36.4' }) })
    ).toEqual({ label: 'Rolling back', detail: 'to 0.36.4', tone: 'bad' })
    expect(
      computerRowStatus({
        ...live,
        upgradeStatus: upgrade('maintenance-required', { target: '0.37.0' })
      })
    ).toEqual({ label: 'Upgrade blocked', detail: 'host maintenance pending', tone: 'bad' })
  })

  it('lets connection trouble outrank a stale upgrade report', () => {
    const failed = upgrade('failed', { target: '0.37.0' })
    expect(
      computerRowStatus({ connected: false, lastSeenAt: null, upgradeStatus: failed })
    ).toEqual({ label: 'Never connected', tone: 'idle' })
    expect(
      computerRowStatus({ ...live, revokedAt: 5, upgradeStatus: upgrade('installing') })
    ).toEqual({ label: 'Revoked', tone: 'bad' })
  })
})

describe('computerUpgradeTitle', () => {
  it('prefers the error, else the versions', () => {
    const base = {
      phase: 'failed',
      currentVersion: '0.36.4',
      hostVersion: '0.37.0',
      updatedAt: 'x'
    }
    expect(computerUpgradeTitle({ ...base, error: 'EACCES' } as never)).toBe('EACCES')
    expect(computerUpgradeTitle({ ...base, maintenanceReason: 'disk full' } as never)).toBe(
      'disk full'
    )
    expect(computerUpgradeTitle(base as never)).toBe('Connector 0.36.4 · host 0.37.0')
  })
})

describe('capabilityNote', () => {
  it('says nothing for the standard set, in any order', () => {
    expect(capabilityNote([...STANDARD_COMPUTER_CAPABILITIES])).toBeNull()
    expect(capabilityNote(['proc', 'fs', 'git', 'pty'])).toBeNull()
  })

  it("does not call a desktop's joined computer different", () => {
    expect(capabilityNote([...STANDARD_COMPUTER_CAPABILITIES, 'desktop'])).toBeNull()
  })

  it('names what is missing and what is extra', () => {
    expect(capabilityNote(['git', 'fs', 'proc'])).toBe('no pty')
    expect(capabilityNote(['pty', 'git', 'fs', 'proc', 'gpu'])).toBe('+gpu')
    expect(capabilityNote(['git', 'gpu'])).toBe('no pty, fs, proc · +gpu')
    expect(capabilityNote([])).toBe('no capabilities')
  })
})
