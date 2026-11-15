/**
 * A worktree setup script's reply (FU1 S4): its output streams to the hub chunk by
 * chunk as it runs (`git.worktreeSetupData`); the final reply carries only the LAST
 * 1 MiB of it (no UI shows the reply's output; diagnostics trim it further), with
 * the total size and whether it was cut — never the whole output in one frame, and
 * never held whole in memory. Under the bound the reply is exactly as before.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createOutputTail, SETUP_OUTPUT_TAIL_BYTES } from './output-tail'
import { runWorktreeSetupScript } from './git-worktree'

describe('createOutputTail', () => {
  it('under the bound: the whole output, trimmed, as before', () => {
    const t = createOutputTail(64)
    t.push('  hello\n')
    t.push('world  \n')
    expect(t.result()).toEqual({ output: 'hello\nworld', outputBytes: 16 })
  })

  it('over the bound: the last bytes only, the total, and that it was cut', () => {
    const t = createOutputTail(10)
    for (let i = 0; i < 100; i++) t.push(`line ${i}\n`)
    const r = t.result()
    expect(r.outputTruncated).toBe(true)
    expect(Buffer.byteLength(r.output)).toBeLessThanOrEqual(10)
    expect(r.output.endsWith('line 99')).toBe(true)
    expect(r.outputBytes).toBe(Array.from({ length: 100 }, (_, i) => `line ${i}\n`).join('').length)
  })

  it('never splits a multi-byte character', () => {
    const t = createOutputTail(5)
    t.push('ééééé') // 10 bytes
    const r = t.result()
    expect(r.output).toMatch(/^é+$/)
    expect(Buffer.byteLength(r.output)).toBeLessThanOrEqual(5)
  })

  it('the default bound is 1 MiB', () => {
    expect(SETUP_OUTPUT_TAIL_BYTES).toBe(1024 * 1024)
  })
})

describe('runWorktreeSetupScript (git.op path)', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'setup-tail-')))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q'], { cwd: dir })

  it('a script printing 3 MiB: the reply holds its last MiB and the total; the stream has it all', async () => {
    mkdirSync(join(dir, '.slay'), { recursive: true })
    const script = join(dir, '.slay', 'worktree-setup.sh')
    writeFileSync(
      script,
      '#!/bin/sh\ni=0\nwhile [ $i -lt 3072 ]; do printf "%01023d\\n" $i; i=$((i+1)); done\necho LAST-LINE\n'
    )
    chmodSync(script, 0o755)
    let streamed = 0
    const r = await runWorktreeSetupScript(dir, dir, null, (chunk) => {
      streamed += Buffer.byteLength(chunk)
    })
    expect(r.ran).toBe(true)
    expect(r.success).toBe(true)
    expect(Buffer.byteLength(r.output ?? '')).toBeLessThanOrEqual(SETUP_OUTPUT_TAIL_BYTES)
    expect(r.output?.endsWith('LAST-LINE')).toBe(true)
    expect(r.outputTruncated).toBe(true)
    expect(r.outputBytes).toBe(3072 * 1024 + 'LAST-LINE\n'.length)
    expect(streamed).toBe(r.outputBytes)
  })
})
