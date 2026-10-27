/**
 * Tests for resolveRepoPath
 */
import { describe, expect, test } from 'vitest'
import { resolveRepoPath } from './resolve-repo'

const repos = [
  { name: 'browser-manage', path: '/code/sandbox/browser-manage' },
  { name: 'memory-system', path: '/code/sandbox/memory-system' }
]

describe('resolveRepoPath', () => {
  // No detected repos → single-repo mode
  test('no child repos → returns projectPath', () => {
    expect(resolveRepoPath('/code/myproject', [], null).path).toBe('/code/myproject')
  })
  test('no child repos → not stale', () => {
    expect(resolveRepoPath('/code/myproject', [], null).stale).toBe(false)
  })

  // repoName matches a detected repo
  test('repoName match → returns matched repo path', () => {
    expect(resolveRepoPath('/code/sandbox', repos, 'memory-system').path).toBe(
      '/code/sandbox/memory-system'
    )
  })
  test('repoName match → not stale', () => {
    expect(resolveRepoPath('/code/sandbox', repos, 'memory-system').stale).toBe(false)
  })

  // repoName set but no match (stale)
  test('stale repoName → falls back to first repo', () => {
    expect(resolveRepoPath('/code/sandbox', repos, 'deleted-repo').path).toBe(
      '/code/sandbox/browser-manage'
    )
  })
  test('stale repoName → flagged stale', () => {
    expect(resolveRepoPath('/code/sandbox', repos, 'deleted-repo').stale).toBe(true)
  })

  // BUG FIX: repoName null with child repos → should return projectPath, NOT first child repo
  test('repoName null + child repos → returns projectPath (not first child)', () => {
    expect(resolveRepoPath('/code/sandbox', repos, null).path).toBe('/code/sandbox')
  })
  test('repoName null + child repos → not stale', () => {
    expect(resolveRepoPath('/code/sandbox', repos, null).stale).toBe(false)
  })

  // Edge: projectPath null
  test('null projectPath, no repos → returns null', () => {
    expect(resolveRepoPath(null, [], null).path).toBe(null)
  })
  test('null projectPath, child repos, no repoName → returns null', () => {
    expect(resolveRepoPath(null, repos, null).path).toBe(null)
  })
})
