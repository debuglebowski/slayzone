/**
 * Contract tests for git:analyzeConflict handler.
 * The loader redirects ./merge-ai to mock-merge-ai.ts.
 */
import { createTestHarness, test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { registerWorktreeHandlers } from '../../../worktrees/src/main/handlers'
import { _mock } from '../../../../shared/test-utils/mock-merge-ai.js'

const h = await createTestHarness()
registerWorktreeHandlers(h.ipcMain as any, h.db as any)

describe('git:analyzeConflict', () => {
  test('parses SUMMARY + ---RESOLUTION--- correctly', async () => {
    _mock.runAiCommand = async () =>
      'SUMMARY: Branch A added a header, branch B changed the footer. They conflict in the middle section.\n---RESOLUTION---\nresolved line 1\nresolved line 2'

    const result = await h.invoke('git:analyzeConflict',
      'claude-code', 'file.ts', 'base content', 'ours content', 'theirs content'
    ) as any
    expect(result.summary).toBe('Branch A added a header, branch B changed the footer. They conflict in the middle section.')
    expect(result.suggestion).toBe('resolved line 1\nresolved line 2')
  })

  test('handles missing separator — returns raw as summary', async () => {
    _mock.runAiCommand = async () => 'Just a plain response without separator'

    const result = await h.invoke('git:analyzeConflict',
      'claude-code', 'file.ts', 'base', 'ours', 'theirs'
    ) as any
    expect(result.summary).toBe('Just a plain response without separator')
    expect(result.suggestion).toBe('')
  })

  test('handles empty AI response', async () => {
    _mock.runAiCommand = async () => ''

    const result = await h.invoke('git:analyzeConflict',
      'codex', 'file.ts', null, 'ours', 'theirs'
    ) as any
    expect(result.summary).toBe('')
    expect(result.suggestion).toBe('')
  })

  test('strips SUMMARY: prefix from output', async () => {
    _mock.runAiCommand = async () =>
      'SUMMARY: conflict explanation\n---RESOLUTION---\nfixed'

    const result = await h.invoke('git:analyzeConflict',
      'claude-code', 'f.ts', null, null, null
    ) as any
    expect(result.summary).toBe('conflict explanation')
    expect(result.suggestion).toBe('fixed')
  })

  test('propagates AI error', async () => {
    _mock.runAiCommand = async () => { throw new Error('Timeout') }

    let threw = false
    try {
      await h.invoke('git:analyzeConflict', 'claude-code', 'f.ts', 'b', 'o', 't')
    } catch { threw = true }
    expect(threw).toBe(true)
  })

  test('handles multiline resolution with code', async () => {
    const resolution = '```ts\nfunction merge() {\n  return "both";\n}\n```'
    _mock.runAiCommand = async () =>
      `SUMMARY: Both branches modified the merge function.\n---RESOLUTION---\n${resolution}`

    const result = await h.invoke('git:analyzeConflict',
      'claude-code', 'merge.ts', 'old', 'ours', 'theirs'
    ) as any
    expect(result.summary).toBe('Both branches modified the merge function.')
    expect(result.suggestion).toBe(resolution)
  })
})

h.cleanup()
console.log('\nDone')
