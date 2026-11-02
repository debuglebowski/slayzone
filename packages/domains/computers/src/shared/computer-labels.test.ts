import { describe, expect, it } from 'vitest'
import {
  computerName,
  computerStatus,
  inheritComputerLabel,
  NO_COMPUTERS_NOTE,
  OFFLINE_MARK,
  outdatedComputerNote,
  runsOnLabel
} from './computer-labels'

describe('computerStatus', () => {
  it('reports a revoked computer as revoked, whatever its socket says', () => {
    expect(computerStatus({ connected: true, usable: true, lastSeenAt: 1, revokedAt: 2 })).toEqual({
      label: 'Revoked',
      tone: 'bad'
    })
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
