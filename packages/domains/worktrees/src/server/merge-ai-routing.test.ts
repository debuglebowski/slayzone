/**
 * The conflict analysis runs an agent CLI (`claude --print` / `codex`): agents run
 * on computers, so with a runner wired the command leaves as one shell command for
 * the caller's computer — argv shell-quoted, the 60s budget kept.
 */
import { afterEach, describe, expect, test } from 'vitest'
// Not './merge-ai': the harness aliases that specifier to its mock.
import { runAiCommand, setAiCommandRunner } from '../server/merge-ai'

afterEach(() => setAiCommandRunner(null))

describe('runAiCommand on a computer', () => {
  test('no computer (null): runs here, as before — refused on a processes-off hub', async () => {
    setAiCommandRunner(async () => null)
    process.env.SLAYZONE_HUB_ENABLE_PROCESSES = '0'
    try {
      await expect(runAiCommand('codex', 'x')).rejects.toThrow(/Connect a computer/)
    } finally {
      delete process.env.SLAYZONE_HUB_ENABLE_PROCESSES
    }
  })

  test('one shell command, the prompt quoted, its stdout the answer', async () => {
    const seen: Array<{ command: string; timeoutMs: number }> = []
    setAiCommandRunner(async (command, timeoutMs) => {
      seen.push({ command, timeoutMs })
      return { stdout: ' SUMMARY: ok \n', stderr: '', status: 0, timedOut: false }
    })
    const out = await runAiCommand('codex', "it's a $(prompt)")
    expect(out).toBe('SUMMARY: ok')
    expect(seen[0]?.timeoutMs).toBe(60_000)
    expect(seen[0]?.command).toBe(`'codex' 'it'"'"'s a $(prompt)'`)
  })

  test("claude: the computer's own ~/.local/bin/claude, expanded there", async () => {
    const seen: string[] = []
    setAiCommandRunner(async (command) => {
      seen.push(command)
      return { stdout: 'x', stderr: '', status: 0, timedOut: false }
    })
    await runAiCommand('claude-code', 'p')
    expect(seen[0]).toBe(
      `"$HOME/.local/bin/claude" '--print' '--allow-dangerously-skip-permissions' 'p'`
    )
  })

  test('a failure or timeout rejects with what the computer said', async () => {
    setAiCommandRunner(async () => ({ stdout: '', stderr: 'no auth', status: 1, timedOut: false }))
    await expect(runAiCommand('codex', 'x')).rejects.toThrow('no auth')
    setAiCommandRunner(async () => ({ stdout: '', stderr: '', status: null, timedOut: true }))
    await expect(runAiCommand('codex', 'x')).rejects.toThrow('Timeout')
  })
})
