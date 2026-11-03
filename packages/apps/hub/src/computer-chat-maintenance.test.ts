import { expect, test } from 'vitest'
import {
  createComputerChatMaintenance,
  createComputerChatCommandBarrier
} from './computer-chat-maintenance'

test('normal computer commands await lifecycle fences, never chat recovery; control frames cannot recurse', async () => {
  const calls: string[] = []
  let fail = false
  const barrier = createComputerChatCommandBarrier({
    lifecycle: async (pc) => {
      calls.push(`lifecycle:${pc}`)
      if (fail) throw new Error('pending')
    }
  })
  for (const method of [
    'chat.request',
    'ping',
    'computer.shutdown',
    'computer.setAllowedRoots',
    'pty.kill',
    'proc.kill',
    'project.list'
  ])
    await barrier('pc', method)
  expect(calls).toEqual([])
  for (const method of [
    'proc.spawn',
    'pty.spawn',
    'fs.writeFile',
    'git.createWorktree',
    'claudeSession.read'
  ])
    await barrier('pc', method)
  expect(calls).toEqual(Array.from({ length: 5 }, () => 'lifecycle:pc'))
  calls.length = 0
  fail = true
  await barrier('pc', 'pty.kill')
  await barrier('pc', 'proc.kill')
  expect(calls).toEqual([])
  await expect(barrier('pc', 'fs.readFile')).rejects.toThrow('pending')
  expect(calls).toEqual(['lifecycle:pc'])
})

test('reconnect orders project sync before recovery and migration, under computer owner', async () => {
  const calls: string[] = []
  let owner: string | null = null
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  const maintenance = createComputerChatMaintenance({
    asOwner: async (id, work) => {
      owner = id
      try {
        return await work()
      } finally {
        owner = null
      }
    },
    projects: async () => {
      calls.push('projects')
      await wait
    },
    recover: async () => {
      expect(owner).toBe('pc')
      calls.push('recover')
    },
    lifecycle: async () => {
      expect(owner).toBe('pc')
      calls.push('lifecycle')
    },
    sessions: async () => {
      expect(owner).toBe('pc')
      calls.push('sessions')
    },
    migrate: async () => {
      expect(owner).toBe('pc')
      calls.push('migrate')
    }
  })
  const first = maintenance.run('pc')
  const overlappingTick = maintenance.run('pc')
  release()
  await Promise.all([first, overlappingTick])
  expect(calls).toEqual(['projects', 'recover', 'lifecycle', 'sessions', 'migrate'])
  expect(owner).toBeNull()
})

test('failed reconnect never migrates before recovery; next tick retries', async () => {
  let attempts = 0,
    migrations = 0
  const maintenance = createComputerChatMaintenance({
    asOwner: async (_id, work) => work(),
    projects: async () => {},
    recover: async () => {
      if (++attempts === 1) throw new Error('offline')
    },
    lifecycle: async () => {},
    sessions: async () => {},
    migrate: async () => {
      migrations++
    }
  })
  await expect(maintenance.run('pc')).rejects.toThrow('offline')
  expect(migrations).toBe(0)
  await maintenance.run('pc')
  expect(migrations).toBe(1)
})

function recordingMaintenance(forces: boolean[], gate?: Promise<void>) {
  return createComputerChatMaintenance({
    asOwner: async (_id, work) => work(),
    projects: async () => {
      await gate
    },
    recover: async (_id, force) => {
      forces.push(force)
    },
    lifecycle: async () => {},
    sessions: async () => {},
    migrate: async () => {}
  })
}

test('only a reconnect forces recovery; idle ticks reuse the recovered state', async () => {
  // A forced recovery bumps the recovery generation, and every open chat
  // reloads its whole history on a new generation — once a minute on idle ticks.
  const forces: boolean[] = []
  const maintenance = recordingMaintenance(forces)
  await maintenance.run('pc', { reconnect: true })
  await maintenance.run('pc')
  await maintenance.run('pc')
  expect(forces).toEqual([true, false, false])
})

test('a reconnect during a running tick still forces recovery after it', async () => {
  const forces: boolean[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const maintenance = recordingMaintenance(forces, gate)
  const tick = maintenance.run('pc')
  const reconnect = maintenance.run('pc', { reconnect: true })
  release()
  await Promise.all([tick, reconnect])
  expect(forces).toEqual([false, true])
})
