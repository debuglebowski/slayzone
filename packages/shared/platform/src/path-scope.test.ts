/**
 * The path scope the hub stamps on a computer request (§9 Phase 7b), review 2 B1:
 * - `projectWide` (a task panel's Worktrees tab) runs a task's op in its PROJECT's
 *   scope — task → project is hub data — so the tab reaches every worktree of the
 *   project; without it a task stays a task scope (another task's worktree refused).
 * - A project scope carries the hub's `worktree_base_path` template, when set, for
 *   the computer to resolve against the project's folder there.
 * - A computer's own-policy refusal is recognised structurally (`isComputerRefusal`).
 */
import { describe, expect, it } from 'vitest'
import { COMPUTER_REFUSED_RPC_CODE, isComputerRefusal, pathScopeFor } from './path-scope'

/** A hub DB with task t1 (project p1), task t0 (no project) and the setting. */
function db(worktreeBase: string | null) {
  return {
    async get<T>(sql: string, params?: unknown[]): Promise<T | undefined> {
      if (sql.includes('FROM tasks')) {
        const id = params?.[0]
        if (id === 't1') return { project_id: 'p1' } as T
        if (id === 't0') return { project_id: null } as T
        return undefined
      }
      if (sql.includes('worktree_base_path'))
        return (worktreeBase === null ? undefined : { value: worktreeBase }) as T
      throw new Error(`unexpected query ${sql}`)
    }
  } as never
}

describe('pathScopeFor', () => {
  it('a task stays a task scope; projectWide makes it its project’s', async () => {
    expect(await pathScopeFor(db(null), { taskId: 't1' }, true)).toEqual({
      kind: 'task',
      taskId: 't1',
      projectId: 'p1',
      hostReads: true
    })
    expect(await pathScopeFor(db(null), { taskId: 't1', projectWide: true }, true)).toEqual({
      kind: 'project',
      projectId: 'p1',
      hostReads: true
    })
    // No project to widen to, or no such task: no scope (the router refuses).
    expect(await pathScopeFor(db(null), { taskId: 't0', projectWide: true }, true)).toBeNull()
    expect(await pathScopeFor(db(null), { taskId: 'gone', projectWide: true }, true)).toBeNull()
  })

  it('a project scope carries the configured worktree base template', async () => {
    expect(
      await pathScopeFor(db(' ../wt-{project-folder-name} '), { projectId: 'p1' }, false)
    ).toEqual({ kind: 'project', projectId: 'p1', worktreeBase: '../wt-{project-folder-name}' })
    expect(await pathScopeFor(db(''), { projectId: 'p1' }, false)).toEqual({
      kind: 'project',
      projectId: 'p1'
    })
    expect(await pathScopeFor(db(null), { taskId: 't1', projectWide: true }, false)).toEqual({
      kind: 'project',
      projectId: 'p1'
    })
  })
})

describe('isComputerRefusal', () => {
  it('is an RpcError with the refusal code, nothing else', () => {
    const rpc = (code: number) => Object.assign(new Error('x'), { name: 'RpcError', code })
    expect(isComputerRefusal(rpc(COMPUTER_REFUSED_RPC_CODE))).toBe(true)
    expect(isComputerRefusal(rpc(-32603))).toBe(false)
    expect(
      isComputerRefusal(Object.assign(new Error('x'), { code: COMPUTER_REFUSED_RPC_CODE }))
    ).toBe(false)
    expect(isComputerRefusal({ name: 'RpcError', code: COMPUTER_REFUSED_RPC_CODE })).toBe(false)
  })
})
