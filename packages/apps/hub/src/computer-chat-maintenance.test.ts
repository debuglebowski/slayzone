import { expect, test } from 'vitest'
import {
  createComputerChatMaintenance,
  createComputerChatCommandBarrier
} from './computer-chat-maintenance'

test('normal computer commands await recovery and lifecycle; control frames cannot recurse', async () => {
  const calls: string[] = []
  let fail = false
  const barrier = createComputerChatCommandBarrier({
    recover: async (pc) => {
      calls.push(`recover:${pc}`)
      if (fail) throw new Error('pending')
    },
    lifecycle: async (pc) => {
      calls.push(`lifecycle:${pc}`)
    }
  })
  for (const method of [
    'chat.request',
    'ping',
    'computer.shutdown',
    'computer.setAllowedRoots',
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
  expect(calls).toEqual(Array.from({ length: 5 }, () => ['recover:pc', 'lifecycle:pc']).flat())
  calls.length = 0
  fail = true
  await expect(barrier('pc', 'fs.readFile')).rejects.toThrow('pending')
  expect(calls).toEqual(['recover:pc'])
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
