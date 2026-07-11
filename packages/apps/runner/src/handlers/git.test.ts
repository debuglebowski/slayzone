import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunnerConfig } from '../config'
import { createGitHandlers } from './git'
import type { RunnerDialer } from './types'

const dialer: RunnerDialer = { notify: () => true }

function ctxWithRoots(roots: string[]) {
  const config: RunnerConfig = {
    hubUrl: 'ws://localhost:0/fleet',
    name: 'test',
    allowedRoots: roots,
    capabilities: ['git']
  }
  return { dialer, config, log: () => {} }
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

let dir: string
let roots: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runner-git-'))
  // Canonicalize so containment holds on macOS (/var → /private/var).
  roots = [realpathSync(tmpdir())]
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createGitHandlers — git.isGitRepo', () => {
  it('is false for a bare directory and true after git init', async () => {
    const handlers = createGitHandlers(ctxWithRoots(roots))
    expect(await handlers['git.isGitRepo']({ path: dir })).toEqual({ isRepo: false })
    git(['init'], dir)
    expect(await handlers['git.isGitRepo']({ path: dir })).toEqual({ isRepo: true })
  })
})

describe('createGitHandlers — git.getCurrentBranch', () => {
  it('returns the checked-out branch name', async () => {
    git(['init'], dir)
    git(['config', 'user.email', 'test@example.com'], dir)
    git(['config', 'user.name', 'Test'], dir)
    git(['commit', '--allow-empty', '-m', 'init'], dir)
    git(['checkout', '-b', 'my-feature'], dir)

    const handlers = createGitHandlers(ctxWithRoots(roots))
    expect(await handlers['git.getCurrentBranch']({ path: dir })).toEqual({ branch: 'my-feature' })
  })

  it('returns null branch for a non-repo path (inside an allowed root)', async () => {
    const handlers = createGitHandlers(ctxWithRoots(roots))
    expect(await handlers['git.getCurrentBranch']({ path: dir })).toEqual({ branch: null })
  })
})

describe('createGitHandlers — allowedRoots guard', () => {
  it('rejects a path outside every allowed root', async () => {
    const handlers = createGitHandlers(ctxWithRoots(roots))
    // `/` is guaranteed to sit outside a tmpdir root.
    await expect(handlers['git.isGitRepo']({ path: '/' })).rejects.toThrow(/allowedRoots/)
  })

  it('rejects a ../ traversal attempt', async () => {
    const handlers = createGitHandlers(ctxWithRoots([realpathSync(dir)]))
    await expect(handlers['git.isGitRepo']({ path: join(dir, '..', 'escape') })).rejects.toThrow(
      /allowedRoots/
    )
  })
})
