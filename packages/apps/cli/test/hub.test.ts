/**
 * CLI hub plumbing tests — resolveHubTarget precedence, cli-hub-target.json perms,
 * Authorization header injection, legacy fallback.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *   --experimental-loader ./packages/shared/test-utils/loader.ts packages/apps/cli/test/hub.test.ts
 */
import http from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { test, expect, describe } from '../../../shared/test-utils/ipc-harness.js'
import { captureAll, captureAllAsync } from './test-harness.js'
import {
  getHubConfigPath,
  normalizeHubUrl,
  removeHubConfig,
  resolveHubTarget,
  writeHubConfig,
  type HubTarget
} from '../src/hub-config'
import { apiGet } from '../src/api'
import { notifyApp } from '../src/db'

// --- env + fs scaffolding -------------------------------------------------

const ENV_KEYS = [
  'SLAYZONE_HUB_ADDRESS',
  'SLAYZONE_MODE',
  'SLAYZONE_HUB_TOKEN',
  'SLAYZONE_ROOT',
  'SLAYZONE_DEV'
] as const
type EnvKey = (typeof ENV_KEYS)[number]

const savedEnv: Partial<Record<EnvKey, string>> = {}
for (const k of ENV_KEYS) {
  if (process.env[k] !== undefined) savedEnv[k] = process.env[k]
}

/** Reset all hub-relevant env vars, then apply the given overrides. */
function setEnv(vars: Partial<Record<EnvKey, string>>): void {
  for (const k of ENV_KEYS) {
    if (vars[k] === undefined) delete process.env[k]
    else process.env[k] = vars[k]
  }
}

const tmpDirs: string[] = []
function freshStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-hub-test-'))
  tmpDirs.push(dir)
  return dir
}

interface SeenRequest {
  method: string
  url: string
  auth: string | null
}

function startServer(): Promise<{
  port: number
  seen: SeenRequest[]
  close: () => Promise<void>
}> {
  return new Promise((resolve) => {
    const seen: SeenRequest[] = []
    const server = http.createServer((req, res) => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        auth: req.headers.authorization ?? null
      })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        port,
        seen,
        close: () => new Promise<void>((r) => server.close(() => r()))
      })
    })
  })
}

/**
 * A minimal DB holding just `settings.server_port` — the durable channel the
 * running server publishes its bound port to, and the ONLY way the CLI finds the
 * local app when no hub is configured.
 *
 * Written where the CLI DERIVES it from the install root: `<ROOT>/storage/` +
 * `slayzone.sqlite` (no SLAYZONE_DEV in these tests ⇒ the packaged filename).
 * Returns the ROOT, which is the only thing the caller can hand the CLI.
 */
function seedServerPortDb(port: number): string {
  const root = freshStateDir()
  const storage = path.join(root, 'storage')
  fs.mkdirSync(storage, { recursive: true })
  const db = new DatabaseSync(path.join(storage, 'slayzone.sqlite'))
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('server_port', String(port))
  db.close()
  return root
}

/** A port that is guaranteed refused: bind, grab the port, close. */
async function deadPort(): Promise<number> {
  const srv = await startServer()
  await srv.close()
  return srv.port
}

// --- tests ------------------------------------------------------------------

await describe('normalizeHubUrl', () => {
  test('strips trailing slashes', () => {
    expect(normalizeHubUrl('http://example.com:8080///')).toBe('http://example.com:8080')
  })

  test('accepts https', () => {
    expect(normalizeHubUrl('https://hub.example.com')).toBe('https://hub.example.com')
  })

  test('rejects non-http(s) schemes and garbage', () => {
    expect(normalizeHubUrl('ftp://example.com')).toBeNull()
    expect(normalizeHubUrl('not a url')).toBeNull()
    expect(normalizeHubUrl('')).toBeNull()
  })

  test('keeps pathname, drops query/fragment, strips path trailing slash only', () => {
    expect(normalizeHubUrl('https://hub.example.com/base/?x=/#f/')).toBe(
      'https://hub.example.com/base'
    )
    expect(normalizeHubUrl('http://example.com:8080/a/b/')).toBe('http://example.com:8080/a/b')
  })
})

await describe('resolveHubTarget precedence', () => {
  test('returns null when no env and no file (legacy)', () => {
    setEnv({ SLAYZONE_ROOT: freshStateDir() })
    expect(resolveHubTarget()).toBeNull()
  })

  test('env ADDRESS wins over file; file token does not leak to env target', () => {
    const dir = freshStateDir()
    setEnv({ SLAYZONE_ROOT: dir })
    writeHubConfig('http://file.example.com:1234', 'file-token')
    // Authority only; local mode (default) composes http://.
    setEnv({
      SLAYZONE_ROOT: dir,
      SLAYZONE_HUB_ADDRESS: 'env.example.com:9999'
    })
    const target = resolveHubTarget()
    expect(target?.baseUrl).toBe('http://env.example.com:9999')
    expect(target?.token).toBeNull()
  })

  test('env ADDRESS composes https:// in remote mode + env token', () => {
    setEnv({
      SLAYZONE_ROOT: freshStateDir(),
      SLAYZONE_HUB_ADDRESS: 'env.example.com',
      SLAYZONE_MODE: 'remote',
      SLAYZONE_HUB_TOKEN: 'env-token'
    })
    const target = resolveHubTarget()
    expect(target?.baseUrl).toBe('https://env.example.com')
    expect(target?.token).toBe('env-token')
  })

  test('file used when env URL unset; file token applies', () => {
    const dir = freshStateDir()
    setEnv({ SLAYZONE_ROOT: dir })
    writeHubConfig('http://file.example.com:1234', 'file-token')
    const target = resolveHubTarget()
    expect(target?.baseUrl).toBe('http://file.example.com:1234')
    expect(target?.token).toBe('file-token')
  })

  test('empty env token means explicitly no token (does not fall back to file token)', () => {
    const dir = freshStateDir()
    setEnv({ SLAYZONE_ROOT: dir })
    writeHubConfig('http://file.example.com:1234', 'file-token')
    setEnv({ SLAYZONE_ROOT: dir, SLAYZONE_HUB_TOKEN: '' })
    const target = resolveHubTarget()
    expect(target?.baseUrl).toBe('http://file.example.com:1234')
    expect(target?.token).toBeNull()
  })

  test('non-object cli-hub-target.json warns and falls back to null', () => {
    const dir = freshStateDir()
    setEnv({ SLAYZONE_ROOT: dir })
    const cfgPath = getHubConfigPath()
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
    fs.writeFileSync(cfgPath, '"just a string"')
    let target: HubTarget | null | undefined
    const { exitCode, stderr } = captureAll(() => {
      target = resolveHubTarget()
    })
    expect(target).toBeNull()
    expect(exitCode).toBeNull()
    expect(stderr.some((s) => s.includes('ignoring invalid hub config'))).toBe(true)
  })

  test('env token overrides file token for a file target', () => {
    const dir = freshStateDir()
    setEnv({ SLAYZONE_ROOT: dir })
    writeHubConfig('http://file.example.com:1234', 'file-token')
    setEnv({ SLAYZONE_ROOT: dir, SLAYZONE_HUB_TOKEN: 'env-token' })
    const target = resolveHubTarget()
    expect(target?.baseUrl).toBe('http://file.example.com:1234')
    expect(target?.token).toBe('env-token')
  })

  test('invalid SLAYZONE_HUB_ADDRESS (carries a scheme) exits 1', () => {
    // ADDRESS must be authority only; a value with a scheme composes to a
    // double-scheme url that normalizeHubUrl rejects → hard exit.
    setEnv({ SLAYZONE_ROOT: freshStateDir(), SLAYZONE_HUB_ADDRESS: 'http://sneaky' })
    const { exitCode, stderr } = captureAll(() => {
      resolveHubTarget()
    })
    expect(exitCode).toBe(1)
    expect(stderr.some((s) => s.includes('Invalid SLAYZONE_HUB_ADDRESS'))).toBe(true)
  })

  test('corrupt cli-hub-target.json warns and falls back to null', () => {
    const dir = freshStateDir()
    setEnv({ SLAYZONE_ROOT: dir })
    const cfgPath = getHubConfigPath()
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
    fs.writeFileSync(cfgPath, '{ not json')
    let target: HubTarget | null | undefined
    const { exitCode, stderr } = captureAll(() => {
      target = resolveHubTarget()
    })
    expect(target).toBeNull()
    expect(exitCode).toBeNull()
    expect(stderr.some((s) => s.includes('ignoring invalid hub config'))).toBe(true)
  })

  test('cli-hub-target.json with invalid URL warns and falls back to null', () => {
    const dir = freshStateDir()
    setEnv({ SLAYZONE_ROOT: dir })
    const cfgPath = getHubConfigPath()
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
    fs.writeFileSync(cfgPath, JSON.stringify({ url: 'ftp://nope' }))
    let target: HubTarget | null | undefined
    const { exitCode, stderr } = captureAll(() => {
      target = resolveHubTarget()
    })
    expect(target).toBeNull()
    expect(exitCode).toBeNull()
    expect(stderr.some((s) => s.includes('ignoring invalid hub URL'))).toBe(true)
  })
})

await describe('writeHubConfig / removeHubConfig', () => {
  test('writes cli-hub-target.json with 0600 perms', () => {
    setEnv({ SLAYZONE_ROOT: freshStateDir() })
    const p = writeHubConfig('http://example.com:1', 'tok')
    expect(p).toBe(getHubConfigPath())
    expect(fs.statSync(p).mode & 0o777).toBe(0o600)
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as { url: string; token?: string }
    expect(parsed.url).toBe('http://example.com:1')
    expect(parsed.token).toBe('tok')
  })

  test('restores 0600 perms on overwrite', () => {
    setEnv({ SLAYZONE_ROOT: freshStateDir() })
    const p = writeHubConfig('http://example.com:1', 'tok')
    fs.chmodSync(p, 0o644)
    writeHubConfig('http://example.com:2', null)
    expect(fs.statSync(p).mode & 0o777).toBe(0o600)
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as { url: string; token?: string }
    expect(parsed.url).toBe('http://example.com:2')
    expect(parsed.token).toBeUndefined()
  })

  test('removeHubConfig removes, then reports nothing to remove', () => {
    setEnv({ SLAYZONE_ROOT: freshStateDir() })
    writeHubConfig('http://example.com:1')
    expect(removeHubConfig()).toBe(true)
    expect(fs.existsSync(getHubConfigPath())).toBe(false)
    expect(removeHubConfig()).toBe(false)
  })
})

await describe('api Authorization header', () => {
  test('attaches Bearer token when hub token configured', async () => {
    const srv = await startServer()
    try {
      setEnv({
        SLAYZONE_ROOT: freshStateDir(),
        SLAYZONE_HUB_ADDRESS: `127.0.0.1:${srv.port}`,
        SLAYZONE_HUB_TOKEN: 'sekret'
      })
      const res = await apiGet<{ ok: boolean }>('/api/ping')
      expect(res.ok).toBe(true)
      expect(srv.seen).toHaveLength(1)
      expect(srv.seen[0].url).toBe('/api/ping')
      expect(srv.seen[0].auth).toBe('Bearer sekret')
    } finally {
      await srv.close()
    }
  })

  test('no Authorization header when hub has no token', async () => {
    const srv = await startServer()
    try {
      setEnv({
        SLAYZONE_ROOT: freshStateDir(),
        SLAYZONE_HUB_ADDRESS: `127.0.0.1:${srv.port}`
      })
      await apiGet<{ ok: boolean }>('/api/ping')
      expect(srv.seen[0].auth).toBeNull()
    } finally {
      await srv.close()
    }
  })

  test('no hub configured: falls back to settings.server_port, no Authorization header', async () => {
    // The local-app path (`hub: false`): no SLAYZONE_HUB_ADDRESS and no cli-hub-target.json,
    // so the port comes from the DB the server publishes it to at boot.
    const srv = await startServer()
    try {
      setEnv({ SLAYZONE_ROOT: seedServerPortDb(srv.port) })
      const res = await apiGet<{ ok: boolean }>('/api/ping')
      expect(res.ok).toBe(true)
      expect(srv.seen[0].url).toBe('/api/ping')
      expect(srv.seen[0].auth).toBeNull()
    } finally {
      await srv.close()
    }
  })

  test('dead hub URL exits 1 with hub connect error', async () => {
    const port = await deadPort()
    setEnv({
      SLAYZONE_ROOT: freshStateDir(),
      SLAYZONE_HUB_ADDRESS: `127.0.0.1:${port}`
    })
    const { exitCode, stderr } = await captureAllAsync(async () => {
      await apiGet('/api/ping')
    })
    expect(exitCode).toBe(1)
    expect(stderr.some((s) => s.includes('Could not connect to SlayZone hub'))).toBe(true)
  })
})

await describe('notifyApp via hub', () => {
  test('posts /api/notify to hub with Bearer token', async () => {
    const srv = await startServer()
    try {
      setEnv({
        SLAYZONE_ROOT: freshStateDir(),
        SLAYZONE_HUB_ADDRESS: `127.0.0.1:${srv.port}`,
        SLAYZONE_HUB_TOKEN: 'sekret'
      })
      await notifyApp()
      expect(srv.seen).toHaveLength(1)
      expect(srv.seen[0].method).toBe('POST')
      expect(srv.seen[0].url).toBe('/api/notify')
      expect(srv.seen[0].auth).toBe('Bearer sekret')
    } finally {
      await srv.close()
    }
  })

  test('warns (does not exit) when hub unreachable', async () => {
    const port = await deadPort()
    setEnv({
      SLAYZONE_ROOT: freshStateDir(),
      SLAYZONE_HUB_ADDRESS: `127.0.0.1:${port}`
    })
    const { exitCode, stderr } = await captureAllAsync(() => notifyApp())
    expect(exitCode).toBeNull()
    expect(stderr.some((s) => s.includes('hub notify failed'))).toBe(true)
  })
})

// --- teardown ---------------------------------------------------------------

for (const k of ENV_KEYS) {
  if (savedEnv[k] === undefined) delete process.env[k]
  else process.env[k] = savedEnv[k]
}
for (const dir of tmpDirs) {
  fs.rmSync(dir, { recursive: true, force: true })
}
console.log('\nDone')
