/**
 * The git panel's ops are ONE table — `gitOpsContract` (input schema + which fields
 * are paths) and `gitOpImpls` (the implementation) — shared by the hub's router and
 * the computer's `git.op` handler, so the two can never declare a wire shape apart.
 * The implementation entry must bundle into the computer: no DB, Electron, React or
 * tRPC in its import graph.
 */
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { describe, expect, test } from 'vitest'
import {
  gitOpsContract,
  gitOpAbsolutePaths,
  gitOpRepoRelativePaths,
  GIT_INTERNAL_OPS
} from '../shared/git-ops-contract'
import { gitOpImpls } from './git-ops'
import { worktreesRouter } from './worktrees-router'

describe('git op contract', () => {
  test('every op has an implementation, and every implementation a contract', () => {
    expect(Object.keys(gitOpImpls).sort()).toEqual(Object.keys(gitOpsContract).sort())
  })

  test('every contract op is a worktrees procedure (bar the internal steps)', () => {
    const procedures = Object.keys(worktreesRouter._def.procedures)
    for (const op of Object.keys(gitOpsContract)) {
      if (GIT_INTERNAL_OPS.has(op)) expect(procedures, op).not.toContain(op)
      else expect(procedures, op).toContain(op)
    }
  })

  test('the path fields it names are string fields of its input', () => {
    for (const [op, def] of Object.entries(gitOpsContract)) {
      const shape = def.input.shape as Record<string, unknown>
      for (const field of [...def.paths, ...def.repoRelative])
        expect(Object.keys(shape), `${op}.${field}`).toContain(field)
      expect(def.paths.length, `${op} names its repo path`).toBeGreaterThan(0)
    }
  })

  test('paths are read out of an input for the jail', () => {
    expect(
      gitOpAbsolutePaths('getResolvedForkGraph', {
        targetPath: '/a',
        repoPath: '/b',
        activeBranch: 'x',
        compareBranch: 'y',
        activeBranchLabel: 'x',
        compareBranchLabel: 'y'
      })
    ).toEqual(['/a', '/b'])
    expect(
      gitOpRepoRelativePaths('getUntrackedFileDiffs', { repoPath: '/r', filePaths: ['a', 'b'] })
    ).toEqual(['a', 'b'])
    expect(
      gitOpRepoRelativePaths('writeResolvedFile', { repoPath: '/r', filePath: 'c', content: '' })
    ).toEqual(['c'])
  })
})

describe('git-ops entry', () => {
  test('bundles for the computer: nothing heavy in its import graph', async () => {
    const entry = fileURLToPath(new URL('./git-ops.ts', import.meta.url))
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
      metafile: true,
      logLevel: 'silent'
    })
    const inputs = Object.keys(result.metafile.inputs)
    const heavy = inputs.filter((i) =>
      /better-sqlite3|electron|react|@trpc|node-pty|\/diagnostics\/src\/server\/index|\/terminal\/src\/server\/index/.test(
        i
      )
    )
    expect(heavy).toEqual([])
  }, 60_000)
})
