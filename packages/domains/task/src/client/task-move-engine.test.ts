/**
 * The move engine against an in-memory journal that behaves like the hub's
 * (`taskMoves.*`): steps in order, pause between steps, a failed step resumed from
 * where it failed, and the same path for a fresh run, a resume and crash recovery.
 */
import { describe, expect, test } from 'vitest'
import {
  nextTaskMoveStep,
  TASK_MOVE_STEPS,
  type TaskMove,
  type TaskMoveStep
} from '@slayzone/task-contracts'
import {
  runTaskMove,
  type TaskMoveJournal,
  type TaskMoveStepRunner,
  type TaskMoveWorkStep
} from './task-move-engine'

function fakeJournal(start: Partial<TaskMove> = {}) {
  let move: TaskMove = {
    id: 'm1',
    direction: 'out',
    peerHubId: 'hub-b',
    targetProjectId: 'p',
    rootTaskIds: ['t1'],
    taskIds: ['t1'],
    includeSubtasks: true,
    step: 'export',
    status: 'running',
    error: null,
    progress: null,
    createdAt: 0,
    updatedAt: 0,
    ...start
  }
  const set = (patch: Partial<TaskMove>): TaskMove => {
    move = { ...move, ...patch }
    return move
  }
  const journal: TaskMoveJournal = {
    get: async () => move,
    advance: async (_id, completed) => {
      if (move.status !== 'running') throw new Error(`advance while ${move.status}`)
      if (completed !== move.step) throw new Error(`advance ${completed} at ${move.step}`)
      return set({ step: nextTaskMoveStep(move.step) as TaskMoveStep, progress: null })
    },
    progress: async (_id, step, done, total) => set({ progress: { step, done, total } }),
    pause: async () => set({ status: 'paused' }),
    fail: async (_id, error) => set({ status: 'failed', error }),
    release: async () => {
      if (move.step !== 'release') throw new Error('release too early')
      return set({ status: 'done' })
    }
  }
  return {
    journal,
    current: () => move,
    resume: () => set({ status: 'running', error: null })
  }
}

const WORK: TaskMoveWorkStep[] = ['export', 'import', 'copy-files', 'links', 'commit']

function recordingSteps(
  ran: string[],
  overrides: Partial<Record<TaskMoveWorkStep, TaskMoveStepRunner>> = {}
): Record<TaskMoveWorkStep, TaskMoveStepRunner> {
  return Object.fromEntries(
    WORK.map((step) => [
      step,
      async (ctx: Parameters<TaskMoveStepRunner>[0]) => {
        ran.push(step)
        await overrides[step]?.(ctx)
      }
    ])
  ) as Record<TaskMoveWorkStep, TaskMoveStepRunner>
}

describe('runTaskMove', () => {
  test('runs every step once, in order, then releases', async () => {
    const j = fakeJournal()
    const ran: string[] = []
    const done = await runTaskMove('m1', {
      journal: j.journal,
      steps: recordingSteps(ran),
      pauseRequested: () => false
    })
    expect(ran).toEqual(WORK)
    expect(done.status).toBe('done')
    expect(TASK_MOVE_STEPS.at(-1)).toBe('release')
  })

  test('pause takes effect between steps; resuming runs only what is left', async () => {
    const j = fakeJournal()
    const ran: string[] = []
    let pause = false
    const steps = recordingSteps(ran, {
      import: async () => {
        pause = true
      }
    })
    const paused = await runTaskMove('m1', {
      journal: j.journal,
      steps,
      pauseRequested: () => pause
    })
    expect(paused).toMatchObject({ status: 'paused', step: 'copy-files' })
    expect(ran).toEqual(['export', 'import'])

    pause = false
    j.resume()
    const done = await runTaskMove('m1', { journal: j.journal, steps, pauseRequested: () => pause })
    expect(done.status).toBe('done')
    expect(ran).toEqual(WORK)
  })

  test('a failing step stops the move there; resumed, that step runs again', async () => {
    const j = fakeJournal()
    const ran: string[] = []
    let failCopy = true
    const steps = recordingSteps(ran, {
      'copy-files': async () => {
        if (failCopy) throw new Error('target hub went away')
      }
    })
    const failed = await runTaskMove('m1', {
      journal: j.journal,
      steps,
      pauseRequested: () => false
    })
    expect(failed).toMatchObject({
      status: 'failed',
      step: 'copy-files',
      error: 'target hub went away'
    })

    failCopy = false
    j.resume()
    const done = await runTaskMove('m1', { journal: j.journal, steps, pauseRequested: () => false })
    expect(done.status).toBe('done')
    expect(ran).toEqual(['export', 'import', 'copy-files', 'copy-files', 'links', 'commit'])
  })

  test('crash recovery is the same call: a journal mid-way continues from its step', async () => {
    const j = fakeJournal({ step: 'links' })
    const ran: string[] = []
    const done = await runTaskMove('m1', {
      journal: j.journal,
      steps: recordingSteps(ran),
      pauseRequested: () => false
    })
    expect(ran).toEqual(['links', 'commit'])
    expect(done.status).toBe('done')
  })

  test('a journal left at lock (crash right after begin) only records it', async () => {
    const j = fakeJournal({ step: 'lock' })
    const ran: string[] = []
    await runTaskMove('m1', {
      journal: j.journal,
      steps: recordingSteps(ran),
      pauseRequested: () => false
    })
    expect(ran).toEqual(WORK)
  })

  test('progress is recorded and reported', async () => {
    const j = fakeJournal()
    const updates: Array<TaskMove['progress']> = []
    await runTaskMove('m1', {
      journal: j.journal,
      steps: recordingSteps([], {
        'copy-files': async ({ reportProgress }) => {
          await reportProgress(5, 10)
          await reportProgress(10, 10)
        }
      }),
      pauseRequested: () => false,
      onUpdate: (m) => updates.push(m.progress)
    })
    expect(updates).toContainEqual({ step: 'copy-files', done: 5, total: 10 })
    expect(updates).toContainEqual({ step: 'copy-files', done: 10, total: 10 })
  })

  test('a move that is not running is answered as it is', async () => {
    const j = fakeJournal({ status: 'paused' })
    const ran: string[] = []
    const out = await runTaskMove('m1', {
      journal: j.journal,
      steps: recordingSteps(ran),
      pauseRequested: () => false
    })
    expect(out.status).toBe('paused')
    expect(ran).toEqual([])
  })
})
