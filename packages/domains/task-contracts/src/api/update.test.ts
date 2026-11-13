/**
 * The task.update contract carries a worktree path or base dir as given: the hub's
 * task-path delegate alone judges it ('' is unset, a path no computer takes fails the
 * update — hub computer-task-paths.ts), so no second rule here can disagree with it.
 */
import { expect, test } from 'vitest'
import { updateTaskInputSchema } from './update'

const id = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'

test("paths parse as given ('' included); absent stays absent", () => {
  expect(updateTaskInputSchema.parse({ id, worktreePath: '', baseDir: '' })).toMatchObject({
    worktreePath: '',
    baseDir: ''
  })
  const absent = updateTaskInputSchema.parse({ id, title: 'T' })
  expect(absent.worktreePath).toBeUndefined()
  expect(absent.baseDir).toBeUndefined()
  expect(updateTaskInputSchema.parse({ id, worktreePath: '/w/x', baseDir: null })).toMatchObject({
    worktreePath: '/w/x',
    baseDir: null
  })
})
