/**
 * What a disabled computer refuses (`startsNewWork`) and what blocks disabling one
 * (`countRunningWork`). Pure: a fake gateway stands in for the computer.
 */
import { describe, expect, test } from 'vitest'
import { HubToComputerMethods as M } from '@slayzone/computer-transport/shared'
import { countRunningWork, startsNewWork } from './computer-new-work'

const invoke = (method: string, target = 'ops') => ({
  kind: 'invoke',
  value: { target, method, args: [], operationId: 'op' }
})

describe('startsNewWork', () => {
  test('spawns, worktrees, setup and gh are new work', () => {
    for (const m of [
      M.ptySpawn,
      M.ptyWarmSpawn,
      M.ptyWarmAdopt,
      M.procSpawn,
      M.gitCreateWorktree,
      M.gitRunWorktreeSetupScript,
      M.slaySetup,
      M.ghExec
    ]) {
      expect(startsNewWork(m, {}), m).toBe(true)
    }
  })

  test('reads, kills and maintenance are not', () => {
    for (const m of [M.ptyList, M.ptyKill, M.ptyWrite, M.fsReadFile, M.fsListDir, M.procKill]) {
      expect(startsNewWork(m, {}), m).toBe(false)
    }
  })

  test('chat: starting a turn is new work; reading, stopping and syncing are not', () => {
    expect(startsNewWork(M.chatRequest, invoke('start'))).toBe(true)
    expect(startsNewWork(M.chatRequest, invoke('send'))).toBe(true)
    expect(startsNewWork(M.chatRequest, invoke('askSideQuestion'))).toBe(true)
    expect(startsNewWork(M.chatRequest, invoke('push', 'queue'))).toBe(true)
    expect(startsNewWork(M.chatRequest, invoke('getReplay'))).toBe(false)
    expect(startsNewWork(M.chatRequest, invoke('interrupt'))).toBe(false)
    expect(startsNewWork(M.chatRequest, invoke('kill'))).toBe(false)
    expect(startsNewWork(M.chatRequest, invoke('clear', 'queue'))).toBe(false)
    expect(startsNewWork(M.chatRequest, { kind: 'bootstrap', value: {} })).toBe(false)
    expect(startsNewWork(M.chatRequest, { kind: 'sessions' })).toBe(false)
  })

  test('chat is fail-closed: an operation nobody classified is new work', () => {
    expect(startsNewWork(M.chatRequest, invoke('someFutureOperation'))).toBe(true)
  })
})

describe('countRunningWork', () => {
  const gateway = (opts: {
    connected?: boolean
    ptys?: string[]
    warms?: string[]
    chats?: string[]
    fail?: boolean
  }) => ({
    listComputers: () =>
      opts.connected === false ? [] : [{ computerId: 'c1', connectedAt: 0, lastSeenAt: 0 }],
    request: async <T>(_id: string, method: string): Promise<T> => {
      if (opts.fail) throw new Error('computer did not answer')
      if (method === M.ptyList)
        return { sessions: (opts.ptys ?? []).map((sessionId) => ({ sessionId })) } as T
      if (method === M.ptyWarmList)
        return { warms: (opts.warms ?? []).map((warmId) => ({ warmId })) } as T
      return (opts.chats ?? []).map((state) => ({ state })) as T
    }
  })

  test('a disconnected computer runs nothing', async () => {
    expect(await countRunningWork(gateway({ connected: false, ptys: ['a'] }), 'c1')).toBe(0)
  })

  test('counts terminals (not unadopted warm agents) and live chat agents', async () => {
    expect(
      await countRunningWork(
        gateway({
          ptys: ['t1', 't2', 'warm-1'],
          warms: ['warm-1'],
          chats: ['running', 'idle', 'dead', 'not-spawned', 'error']
        }),
        'c1'
      )
    ).toBe(4)
    expect(await countRunningWork(gateway({ warms: ['warm-1'], ptys: ['warm-1'] }), 'c1')).toBe(0)
  })

  test('a computer that cannot answer is not read as idle', async () => {
    await expect(countRunningWork(gateway({ fail: true }), 'c1')).rejects.toThrow()
  })
})
