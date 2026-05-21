import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { formatHookCommand } from './hook-paths'
import { installNotifyScript } from './notify-script-installer'

/**
 * End-to-end regression test for issue #88.
 *
 * Installs notify.sh under a path containing a SPACE (forces the quoting
 * branch), builds the hook `command` exactly as the installers store it, then
 * runs it the way an agent CLI does — `bash -c <command>` — and asserts the
 * envelope reaches a loopback HTTP listener.
 *
 * On the Windows CI runner `bash` is Git Bash + the temp path is a real
 * backslash NTFS path, so this reproduces the exact #88 failure (bash eating
 * backslashes) and proves the fix.
 */

const tmpDirs: string[] = []

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** Loopback server that resolves with the first POSTed JSON body. */
function captureOnePost(): { url: Promise<string>; received: Promise<unknown>; close: () => void } {
  let resolveUrl!: (u: string) => void
  let resolveBody!: (b: unknown) => void
  const url = new Promise<string>((r) => (resolveUrl = r))
  const received = new Promise<unknown>((r) => (resolveBody = r))
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.writeHead(200).end('{}')
      try {
        resolveBody(JSON.parse(body))
      } catch {
        resolveBody({ __unparsed: body })
      }
    })
  })
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address()
    if (addr && typeof addr === 'object') resolveUrl(`http://127.0.0.1:${addr.port}/api/agent-hook`)
  })
  return { url, received, close: () => server.close() }
}

describe('hook execution (issue #88)', () => {
  test('a hook installed under a spaced path fires via bash and POSTs the envelope', async () => {
    // Temp dir whose name contains a space — forces formatHookCommand to quote.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slz hook-'))
    tmpDirs.push(root)
    const scriptPath = path.join(root, 'hooks', 'notify.sh')

    const { path: installedAt } = await installNotifyScript({ targetPath: scriptPath })
    expect(fs.existsSync(installedAt)).toBe(true)

    const server = captureOnePost()
    try {
      const hookUrl = await server.url
      const command = formatHookCommand(installedAt)
      // A spaced path MUST come back quoted, else bash would split it.
      expect(command.startsWith("'")).toBe(true)

      // Run the hook the way Claude Code / Gemini do: `bash -c <command>`,
      // event JSON on stdin.
      execFileSync('bash', ['-c', command], {
        input: '{"hook_event_name":"SessionStart"}',
        env: {
          ...process.env,
          SLAYZONE_AGENT_HOOK_URL: hookUrl,
          SLAYZONE_AGENT_ID: 'claude-code'
        }
      })

      const body = (await server.received) as { agentId?: string; hookEvent?: string }
      expect(body.agentId).toBe('claude-code')
      expect(body.hookEvent).toBe('SessionStart')
    } finally {
      server.close()
    }
  }, 20_000)
})
