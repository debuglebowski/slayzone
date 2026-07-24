import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawn, spawnSync } from 'child_process'
import { describe, test, expect } from 'vitest'
import { installNotifyScript } from './notify-script-installer'

/**
 * Integration test: notify.sh under Gemini event names.
 * Verifies the universal stdout `{}\n` contract (required for Gemini, which
 * blocks waiting for a hook response) and that POST envelopes carry the
 * Gemini event name through unchanged.
 */
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'slayzone-notify-gemini-'))
}

function cleanup(...dirs: string[]) {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {}
  }
}

function writeCurlStub(binDir: string, capturePath: string) {
  const stub = `#!/bin/bash\nwhile [ $# -gt 0 ]; do\n  case "$1" in\n    --data-binary) shift; printf '%s' "$1" > "${capturePath}";;\n  esac\n  shift\ndone\nexit 0\n`
  fs.writeFileSync(path.join(binDir, 'curl'), stub, { mode: 0o755 })
}

const GEMINI_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'BeforeAgent',
  'AfterAgent',
  'AfterTool'
] as const

describe('notify.sh under Gemini', () => {
  test('emits exactly "{}\\n" on stdout (Gemini hook contract)', async () => {
    if (process.platform === 'win32') return
    const dir = tmpDir()
    try {
      const target = path.join(dir, 'notify.sh')
      await installNotifyScript({ targetPath: target })

      const binDir = path.join(dir, 'bin')
      fs.mkdirSync(binDir)
      writeCurlStub(binDir, path.join(dir, 'capture.json'))

      const stdin = '{"hook_event_name":"BeforeAgent","session_id":"abc"}'
      const res = spawnSync('bash', [target], {
        input: stdin,
        env: {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          SLAYZONE_AGENT_HOOK_URL: 'http://127.0.0.1:1/api/agent-hook',
          SLAYZONE_AGENT_ID: 'gemini'
        }
      })
      expect(res.status).toBe(0)
      expect(res.stdout.toString()).toBe('{}\n')
    } finally {
      cleanup(dir)
    }
  })

  test('still emits "{}\\n" even when curl fails (POST unreachable)', async () => {
    if (process.platform === 'win32') return
    const dir = tmpDir()
    try {
      const target = path.join(dir, 'notify.sh')
      await installNotifyScript({ targetPath: target })

      // Stub curl with one that always exits 1 — simulates POST failure
      // without removing bash from PATH (spawnSync needs bash).
      const binDir = path.join(dir, 'bin')
      fs.mkdirSync(binDir)
      fs.writeFileSync(path.join(binDir, 'curl'), '#!/bin/bash\nexit 1\n', { mode: 0o755 })

      const stdin = '{"hook_event_name":"BeforeAgent"}'
      const res = spawnSync('bash', [target], {
        input: stdin,
        env: {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          SLAYZONE_AGENT_HOOK_URL: 'http://127.0.0.1:1/api/agent-hook',
          SLAYZONE_AGENT_ID: 'gemini'
        }
      })
      expect(res.status).toBe(0)
      expect(res.stdout.toString()).toBe('{}\n')
    } finally {
      cleanup(dir)
    }
  })

  test.each(GEMINI_EVENTS)('POSTs benign envelope carrying event="%s" in raw', async (eventName) => {
    if (process.platform === 'win32') return
    const dir = tmpDir()
    try {
      const target = path.join(dir, 'notify.sh')
      await installNotifyScript({ targetPath: target })

      const binDir = path.join(dir, 'bin')
      fs.mkdirSync(binDir)
      const capture = path.join(dir, 'capture.json')
      writeCurlStub(binDir, capture)

      const stdin = `{"hook_event_name":"${eventName}","session_id":"sess-1"}`
      const res = spawnSync('bash', [target], {
        input: stdin,
        env: {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          SLAYZONE_AGENT_HOOK_URL: 'http://127.0.0.1:1/api/agent-hook',
          SLAYZONE_AGENT_ID: 'gemini',
          // The app packs identity into ctx; the benign forwarder ships it verbatim.
          SLAYZONE_HOOK_CONTEXT: '{"v":1,"taskId":"task-1","agentId":"gemini"}'
        }
      })
      expect(res.status).toBe(0)
      const env = JSON.parse(fs.readFileSync(capture, 'utf8'))
      // Benign forwarder: agentId + THREE opaque channels, no per-field naming.
      expect(env.agentId).toBe('gemini')
      // The event name rides inside the verbatim stdin payload (`raw`), NOT a
      // top-level `hookEvent` — the server extracts it.
      expect(env.raw.hook_event_name).toBe(eventName)
      // Identity comes from the opaque ctx blob, forwarded verbatim.
      expect(env.ctx.taskId).toBe('task-1')
      // No argv → arg null.
      expect(env.arg).toBeNull()
    } finally {
      cleanup(dir)
    }
  })

  test('POSTs ctx={} when SLAYZONE_HOOK_CONTEXT is unset (never crashes)', async () => {
    if (process.platform === 'win32') return
    const dir = tmpDir()
    try {
      const target = path.join(dir, 'notify.sh')
      await installNotifyScript({ targetPath: target })

      const binDir = path.join(dir, 'bin')
      fs.mkdirSync(binDir)
      const capture = path.join(dir, 'capture.json')
      writeCurlStub(binDir, capture)

      const res = spawnSync('bash', [target], {
        input: '{"hook_event_name":"SessionStart"}',
        env: {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          SLAYZONE_AGENT_HOOK_URL: 'http://127.0.0.1:1/api/agent-hook',
          SLAYZONE_AGENT_ID: 'gemini'
        }
      })
      expect(res.status).toBe(0)
      const env = JSON.parse(fs.readFileSync(capture, 'utf8'))
      expect(env.ctx).toEqual({})
      expect(env.raw.hook_event_name).toBe('SessionStart')
    } finally {
      cleanup(dir)
    }
  })

  // REGRESSION (OpenCode hang): the plugin invokes `bash notify.sh '<json>'`
  // with the payload on argv $1 and NO stdin write. Inside a SlayZone PTY the
  // child inherits the terminal's stdin, which never sends EOF — so an
  // unconditional `cat` would block FOREVER. Reproduce by leaving stdin OPEN
  // (a pipe we never close/write) and asserting the script still exits promptly.
  test('argv-payload invocation must NOT block on an open stdin (OpenCode shape)', async () => {
    if (process.platform === 'win32') return
    const dir = tmpDir()
    try {
      const target = path.join(dir, 'notify.sh')
      await installNotifyScript({ targetPath: target })
      const binDir = path.join(dir, 'bin')
      fs.mkdirSync(binDir)
      const capture = path.join(dir, 'capture.json')
      writeCurlStub(binDir, capture)

      const exitCode = await new Promise<number | 'TIMEOUT'>((resolve) => {
        // stdio[0]='pipe' + never writing/ending it = an open stdin with no EOF,
        // exactly like the inherited PTY stdin OpenCode's `$` hands the child.
        const child = spawn('bash', [target, '{"hook_event_name":"Stop"}'], {
          stdio: ['pipe', 'ignore', 'ignore'],
          env: {
            PATH: `${binDir}:${process.env.PATH ?? ''}`,
            SLAYZONE_AGENT_HOOK_URL: 'http://127.0.0.1:1/api/agent-hook',
            SLAYZONE_AGENT_ID: 'opencode'
          }
        })
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          resolve('TIMEOUT')
        }, 5000)
        child.on('exit', (code) => {
          clearTimeout(timer)
          resolve(code ?? -1)
        })
        // Deliberately DO NOT write or end child.stdin — leave it open.
      })

      expect(exitCode).toBe(0) // TIMEOUT here = the hang regression
      // And it still relayed: argv payload captured, stdin channel is null.
      const env = JSON.parse(fs.readFileSync(capture, 'utf8'))
      expect(env.arg).toBe('{"hook_event_name":"Stop"}')
      expect(env.raw).toBeNull()
    } finally {
      cleanup(dir)
    }
  }, 15_000)

  // The ONE remaining bit of shell logic is the generic awk JSON-string escaper
  // for argv $1. It must produce a valid JSON string for arbitrary bytes —
  // quotes, backslashes, tabs — so the whole envelope stays parseable. If this
  // breaks, the server sees corrupt JSON and drops the hook silently.
  test.each([
    ['double quotes', 'say "hi" now', 'say "hi" now'],
    ['backslashes', 'a\\b\\c', 'a\\b\\c'],
    ['tab', 'a\tb', 'a\tb'],
    ['mixed', 'x"\\\ty', 'x"\\\ty']
  ])('argv escaper: %s → valid JSON string round-trips', async (_label, argValue, expected) => {
    if (process.platform === 'win32') return
    const dir = tmpDir()
    try {
      const target = path.join(dir, 'notify.sh')
      await installNotifyScript({ targetPath: target })
      const binDir = path.join(dir, 'bin')
      fs.mkdirSync(binDir)
      const capture = path.join(dir, 'capture.json')
      writeCurlStub(binDir, capture)

      // Pass the tricky value as argv $1 (Antigravity/OpenCode channel). No stdin.
      const res = spawnSync('bash', [target, argValue], {
        input: '',
        env: {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          SLAYZONE_AGENT_HOOK_URL: 'http://127.0.0.1:1/api/agent-hook',
          SLAYZONE_AGENT_ID: 'antigravity'
        }
      })
      expect(res.status).toBe(0)
      // The whole envelope must parse (proves the escaper produced valid JSON)…
      const env = JSON.parse(fs.readFileSync(capture, 'utf8'))
      // …and `arg` must decode back to the exact original bytes.
      expect(env.arg).toBe(expected)
    } finally {
      cleanup(dir)
    }
  })
})
