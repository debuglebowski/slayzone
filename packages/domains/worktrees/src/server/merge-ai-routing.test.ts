/**
 * The conflict analysis runs an agent CLI (`claude --print` / `codex`): agents run
 * on computers, so with a runner wired it leaves as one program + args for the
 * caller's computer (resolved and run there, no shell) — the 60s budget kept.
 */
import { afterEach, describe, expect, test } from 'vitest'
// Not './merge-ai': the harness aliases that specifier to its mock.
import { runAiCommand, setAiCommandRunner } from '../server/merge-ai'

afterEach(() => setAiCommandRunner(null))

describe('runAiCommand on a computer', () => {
  test('no computer (null), on any hub: "connect a computer" — the hub runs no agent', async () => {
    setAiCommandRunner(async () => null)
    await expect(runAiCommand('codex', 'x')).rejects.toThrow(/Connect a computer/)
    setAiCommandRunner(null)
    await expect(runAiCommand('codex', 'x')).rejects.toThrow(/Connect a computer/)
  })

  // No shell line built here: the hub's POSIX quoting and `$HOME` broke on a
  // Windows computer. The computer resolves the program and runs it unsplit.
  test('a program and its args, unquoted — the prompt one argument', async () => {
    const seen: Array<{ run: unknown; timeoutMs: number }> = []
    setAiCommandRunner(async (run, timeoutMs) => {
      seen.push({ run, timeoutMs })
      return { stdout: ' SUMMARY: ok \n', stderr: '', status: 0, timedOut: false }
    })
    const out = await runAiCommand('codex', "it's a $(prompt)")
    expect(out).toBe('SUMMARY: ok')
    expect(seen[0]?.timeoutMs).toBe(60_000)
    // Headless (`codex exec`), the prompt by stdin (`-`): a Windows cmd line ends
    // at its first newline, so a multi-line prompt never rides argv.
    expect(seen[0]?.run).toEqual({ file: 'codex', args: ['exec', '-'], stdin: "it's a $(prompt)" })
  })

  test("claude: on the computer's PATH, else its own ~/.local/bin/claude", async () => {
    const seen: unknown[] = []
    setAiCommandRunner(async (run) => {
      seen.push(run)
      return { stdout: 'x', stderr: '', status: 0, timedOut: false }
    })
    await runAiCommand('claude-code', 'p')
    expect(seen[0]).toEqual({
      file: 'claude',
      args: ['--print', '--allow-dangerously-skip-permissions'],
      stdin: 'p',
      homeFallbacks: ['.local/bin/claude']
    })
  })

  test('a failure or timeout rejects with what the computer said', async () => {
    setAiCommandRunner(async () => ({ stdout: '', stderr: 'no auth', status: 1, timedOut: false }))
    await expect(runAiCommand('codex', 'x')).rejects.toThrow('no auth')
    setAiCommandRunner(async () => ({ stdout: '', stderr: '', status: null, timedOut: true }))
    await expect(runAiCommand('codex', 'x')).rejects.toThrow('Timeout')
  })
})
