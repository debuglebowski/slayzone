/**
 * The task.update contract: a worktree path or base dir given as '' is unset (null).
 * A computer takes only absolute paths, so '' must never reach one (found by the
 * migration persona suite, tools/migration-personas, p10-v0380-worktrees).
 */
import { expect, test } from 'vitest'
import { updateTaskInputSchema } from './update'

const id = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'

test("'' paths parse as null; absent stays absent; a path stays", () => {
  expect(updateTaskInputSchema.parse({ id, worktreePath: '', baseDir: '' })).toMatchObject({
    worktreePath: null,
    baseDir: null
  })
  const absent = updateTaskInputSchema.parse({ id, title: 'T' })
  expect(absent.worktreePath).toBeUndefined()
  expect(absent.baseDir).toBeUndefined()
  expect(updateTaskInputSchema.parse({ id, worktreePath: '/w/x', baseDir: null })).toMatchObject({
    worktreePath: '/w/x',
    baseDir: null
  })
})
