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

/** Loopback server that resolves with the first POSTed JSON body + its headers. */
function captureOnePost(): {
  url: Promise<string>
  received: Promise<unknown>
  headers: Promise<http.IncomingHttpHeaders>
  close: () => void
} {
  let resolveUrl!: (u: string) => void
  let resolveBody!: (b: unknown) => void
  let resolveHeaders!: (h: http.IncomingHttpHeaders) => void
  const url = new Promise<string>((r) => (resolveUrl = r))
  const received = new Promise<unknown>((r) => (resolveBody = r))
  const headers = new Promise<http.IncomingHttpHeaders>((r) => (resolveHeaders = r))
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.writeHead(200).end('{}')
      resolveHeaders(req.headers)
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
  return { url, received, headers, close: () => server.close() }
}

describe('hook execution (issue #88)', () => {
  test('a hook installed under a spaced path fires via bash and POSTs the benign envelope', async () => {
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
      // event JSON on stdin. The app packs its identity blob into
      // SLAYZONE_HOOK_CONTEXT; the benign forwarder ships it VERBATIM as `ctx`.
      execFileSync('bash', ['-c', command], {
        input: '{"hook_event_name":"SessionStart","session_id":"sess-xyz"}',
        env: {
          ...process.env,
          SLAYZONE_AGENT_HOOK_URL: hookUrl,
          SLAYZONE_AGENT_ID: 'claude-code',
          SLAYZONE_HOOK_CONTEXT: '{"v":1,"taskId":"task-abc","agentId":"claude-code","channel":"dev"}'
        }
      })

      // The benign forwarder posts THREE opaque channels + agentId — it does NOT
      // grep/name any field. The server does all extraction.
      const body = (await server.received) as {
        agentId?: string
        ctx?: { taskId?: string; channel?: string }
        raw?: { hook_event_name?: string; session_id?: string }
        arg?: string | null
      }
      expect(body.agentId).toBe('claude-code')
      // ctx forwarded verbatim (parsed back to the exact blob the app packed).
      expect(body.ctx).toMatchObject({ taskId: 'task-abc', channel: 'dev' })
      // stdin payload forwarded verbatim as `raw`.
      expect(body.raw).toMatchObject({ hook_event_name: 'SessionStart', session_id: 'sess-xyz' })
      // No argv → arg is null.
      expect(body.arg).toBeNull()

      // No auth header — the hook always posts to loopback, never carries a bearer.
      const headers = await server.headers
      expect(headers.authorization).toBeUndefined()
    } finally {
      server.close()
    }
  }, 20_000)

  test('forwards argv $1 opaquely as `arg` (Antigravity event name / OpenCode payload)', async () => {
    // Antigravity passes the event NAME as argv $1 (its stdin omits it); the
    // benign forwarder ships it opaquely as `arg` and the server derives the
    // event from it. Proves the argv channel survives the dumb forwarder.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slz-argv-'))
    tmpDirs.push(root)
    const scriptPath = path.join(root, 'hooks', 'notify.sh')

    const { path: installedAt } = await installNotifyScript({ targetPath: scriptPath })
    const server = captureOnePost()
    try {
      const hookUrl = await server.url
      // Antigravity's installer appends the event name after the script path.
      const command = `${formatHookCommand(installedAt)} PreInvocation`
      execFileSync('bash', ['-c', command], {
        input: '{"conversationId":"conv-1"}',
        env: {
          ...process.env,
          SLAYZONE_AGENT_HOOK_URL: hookUrl,
          SLAYZONE_AGENT_ID: 'antigravity',
          SLAYZONE_HOOK_CONTEXT: '{"v":1,"taskId":"ag-task","agentId":"antigravity"}'
        }
      })

      const body = (await server.received) as { agentId?: string; arg?: string | null }
      expect(body.agentId).toBe('antigravity')
      expect(body.arg).toBe('PreInvocation')
    } finally {
      server.close()
    }
  }, 20_000)
})
