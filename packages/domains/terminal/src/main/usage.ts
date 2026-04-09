import type { IpcMain } from 'electron'
import { net } from 'electron'
import { execFile, spawn } from 'child_process'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import type Database from 'better-sqlite3'
import type { ProviderUsage, UsageWindow, UsageProviderConfig } from '@slayzone/terminal/shared'

const TIMEOUT_MS = 10_000
const MIN_BACKOFF_MS = 30_000    // minimum backoff on 429 (even if retry-after says 0)
const FALLBACK_CLAUDE_VERSION = '2.1.0'

let cachedClaudeVersion: string | null = null

function getClaudeVersion(): Promise<string> {
  if (cachedClaudeVersion) return Promise.resolve(cachedClaudeVersion)
  return new Promise((resolve) => {
    execFile('claude', ['--version'], { timeout: 5_000 }, (err, stdout) => {
      if (err || !stdout.trim()) return resolve(FALLBACK_CLAUDE_VERSION)
      // Output may be "claude-code/1.0.33" or "1.0.33" — extract version
      const match = stdout.trim().match(/(\d+\.\d+\.\d+)/)
      cachedClaudeVersion = match?.[1] ?? FALLBACK_CLAUDE_VERSION
      resolve(cachedClaudeVersion)
    })
  })
}

// ── Provider metadata ────────────────────────────────────────────────

interface ProviderMeta { id: string; label: string; cli: string; vendor: string }
const CLAUDE: ProviderMeta = { id: 'claude', label: 'Claude', cli: 'claude', vendor: 'Anthropic' }
const CODEX: ProviderMeta = { id: 'codex', label: 'Codex', cli: 'codex', vendor: 'OpenAI' }

// ── Error helpers ────────────────────────────────────────────────────

function usageError(p: ProviderMeta, error: string): ProviderUsage {
  return { provider: p.id, label: p.label, windows: [], error, fetchedAt: Date.now() }
}

class RateLimitError extends Error {
  retryAfterMs: number
  constructor(retryAfterMs: number) {
    super('Rate limited')
    this.retryAfterMs = retryAfterMs
  }
}

function parseRetryAfter(res: Response): number {
  const header = res.headers.get('retry-after')
  if (!header) return 60_000 // default 60s backoff
  const secs = Number(header)
  if (!Number.isNaN(secs)) return secs * 1000
  // HTTP-date format
  const date = Date.parse(header)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return 60_000
}

function httpError(status: number, p: ProviderMeta): string {
  if (status === 401) return `Token expired — re-authenticate with \`${p.cli}\``
  if (status === 403) return `Access denied — check your ${p.label} plan`
  if (status >= 500) return `${p.vendor} API error (${status})`
  return `HTTP ${status}`
}

function friendlyError(e: unknown): string {
  if (!(e instanceof Error)) return 'Unknown error'
  const msg = e.message
  if (msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('ERR_NETWORK'))
    return 'Network error — check your connection'
  if (msg.includes('ETIMEDOUT') || msg.includes('UND_ERR_CONNECT_TIMEOUT'))
    return 'Request timed out'
  if (msg.includes('CERT') || msg.includes('SSL'))
    return 'SSL error — VPN or proxy may be interfering'
  return msg
}

// ── Dot-path extraction ─────────────────────────────────────────────

function getByPath(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => o?.[k], obj)
}

// ── Claude (Anthropic OAuth API) ─────────────────────────────────────

function getKeychainValue(service: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('security', [
      'find-generic-password',
      '-s', service,
      '-w'
    ])

    let out = ''
    proc.stdout?.on('data', (d) => { out += d.toString() })
    proc.on('close', (code) => {
      if (code !== 0 || !out.trim()) return resolve(null)
      resolve(out.trim())
    })
    proc.on('error', () => resolve(null))

    setTimeout(() => { proc.kill(); resolve(null) }, TIMEOUT_MS)
  })
}

async function getFileToken(): Promise<string | null> {
  try {
    const raw = await readFile(join(homedir(), '.claude', '.credentials.json'), 'utf-8')
    return JSON.parse(raw)?.claudeAiOauth?.accessToken ?? null
  } catch {
    return null
  }
}

function getClaudeToken(): Promise<string | null> {
  if (process.platform === 'darwin') {
    return getKeychainValue('Claude Code-credentials').then((raw) => {
      if (!raw) return null
      try {
        return JSON.parse(raw)?.claudeAiOauth?.accessToken ?? null
      } catch {
        return null
      }
    })
  }
  // Linux: confirmed ~/.claude/.credentials.json (see #51)
  // Windows: unverified — assumed same file-based storage. May need
  // Windows Credential Manager support if this doesn't work.
  return getFileToken()
}

function mapWindow(key: string, label: string, w: { utilization: number; resets_at: string } | null): UsageWindow | null {
  if (!w) return null
  return { key, label, utilization: w.utilization, resetsAt: w.resets_at }
}

async function fetchClaudeUsageWithToken(token: string): Promise<ProviderUsage> {
  const version = await getClaudeVersion()
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      'Authorization': `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json',
      'User-Agent': `claude-code/${version}`,
    }
  })

  if (res.status === 429) throw new RateLimitError(parseRetryAfter(res))
  if (!res.ok) return usageError(CLAUDE, httpError(res.status, CLAUDE))

  const data = await res.json()
  const windows: UsageWindow[] = [
    mapWindow('fiveHour', '5h', data.five_hour),
    mapWindow('sevenDay', '7d', data.seven_day),
    mapWindow('sevenDayOpus', 'Opus', data.seven_day_opus),
    mapWindow('sevenDaySonnet', 'Son.', data.seven_day_sonnet),
  ].filter((w): w is UsageWindow => w !== null)

  return { provider: CLAUDE.id, label: CLAUDE.label, windows, error: null, fetchedAt: Date.now() }
}

// ── Codex (ChatGPT backend API) ──────────────────────────────────────

interface CodexAuth {
  accessToken: string
  accountId: string
}

async function getCodexAuth(): Promise<CodexAuth | null> {
  try {
    const raw = await readFile(join(homedir(), '.codex', 'auth.json'), 'utf-8')
    const parsed = JSON.parse(raw)
    const tokens = parsed?.tokens
    if (!tokens?.access_token || !tokens?.account_id) return null
    return { accessToken: tokens.access_token, accountId: tokens.account_id }
  } catch {
    return null
  }
}

function mapCodexWindow(key: string, label: string, w: { used_percent: number; reset_at: number } | null): UsageWindow | null {
  if (!w) return null
  return { key, label, utilization: w.used_percent, resetsAt: new Date(w.reset_at * 1000).toISOString() }
}

async function fetchCodexUsageWithToken(auth: CodexAuth): Promise<ProviderUsage> {
  // Electron's net module uses Chromium's HTTP stack (HTTP/2) which bypasses Cloudflare JA3 fingerprint checks
  const res = await net.fetch('https://chatgpt.com/backend-api/wham/usage', {
    headers: {
      'Authorization': `Bearer ${auth.accessToken}`,
      'ChatGPT-Account-Id': auth.accountId,
      'User-Agent': 'codex-cli',
      'Accept': 'application/json'
    }
  })

  if (res.status === 429) throw new RateLimitError(parseRetryAfter(res))
  if (!res.ok) return usageError(CODEX, httpError(res.status, CODEX))

  const data = await res.json()
  const rl = data.rate_limit
  const windows: UsageWindow[] = [
    mapCodexWindow('fiveHour', '5h', rl?.primary_window),
    mapCodexWindow('sevenDay', '7d', rl?.secondary_window),
  ].filter((w): w is UsageWindow => w !== null)

  return { provider: CODEX.id, label: CODEX.label, windows, error: null, fetchedAt: Date.now() }
}

// ── Custom provider fetcher ─────────────────────────────────────────

async function resolveAuth(config: UsageProviderConfig): Promise<Record<string, string>> {
  const headers: Record<string, string> = {}

  if (config.authType === 'bearer-env' && config.authEnvVar) {
    const token = process.env[config.authEnvVar]
    if (!token) throw new Error(`Env var ${config.authEnvVar} not set`)
    const name = config.authHeaderName || 'Authorization'
    const template = config.authHeaderTemplate || 'Bearer {token}'
    headers[name] = template.replace('{token}', token)
  }

  if (config.authType === 'file-json' && config.authFilePath) {
    const filePath = config.authFilePath.replace(/^~/, homedir())
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    const paths = Array.isArray(config.authFileTokenPath)
      ? config.authFileTokenPath
      : config.authFileTokenPath ? [config.authFileTokenPath] : []
    let token: string | null = null
    for (const p of paths) {
      token = getByPath(parsed, p) ?? null
      if (token) break
    }
    if (!token) throw new Error(`Token not found at path: ${paths.join(' | ')}`)
    const name = config.authHeaderName || 'Authorization'
    const template = config.authHeaderTemplate || 'Bearer {token}'
    headers[name] = template.replace('{token}', String(token))
  }

  if (config.authType === 'keychain' && config.authKeychainService) {
    const raw = await getKeychainValue(config.authKeychainService)
    if (!raw) throw new Error(`Keychain entry "${config.authKeychainService}" not found`)
    let token: string = raw
    if (config.authKeychainTokenPath) {
      try {
        const parsed = JSON.parse(raw)
        token = getByPath(parsed, config.authKeychainTokenPath) ?? null
        if (!token) throw new Error(`Token not found at path: ${config.authKeychainTokenPath}`)
      } catch (e) {
        if (e instanceof SyntaxError) throw new Error('Keychain value is not valid JSON')
        throw e
      }
    }
    const name = config.authHeaderName || 'Authorization'
    const template = config.authHeaderTemplate || 'Bearer {token}'
    headers[name] = template.replace('{token}', String(token))
  }

  if (config.extraHeaders) {
    for (const [k, v] of Object.entries(config.extraHeaders)) {
      headers[k] = v
    }
  }

  return headers
}

function parseResetsAt(value: any, format?: string): string {
  if (format === 'unix-s') return new Date(Number(value) * 1000).toISOString()
  if (format === 'unix-ms') return new Date(Number(value)).toISOString()
  return String(value) // assume ISO
}

function resolveLabel(raw: string, mapping: UsageProviderConfig['windowMapping']): string {
  if (mapping.labelMap?.[raw]) return mapping.labelMap[raw]
  return raw
}

function extractWindows(data: any, config: UsageProviderConfig): UsageWindow[] {
  const mapping = config.windowMapping
  const windows: UsageWindow[] = []

  if (config.singleWindow) {
    const util = getByPath(data, mapping.utilization)
    if (util == null) return []
    const rawLabel = mapping.label.startsWith('=') ? mapping.label.slice(1) : (getByPath(data, mapping.label) ?? mapping.label)
    windows.push({
      key: mapping.key ? getByPath(data, mapping.key) ?? 'default' : 'default',
      label: resolveLabel(rawLabel, mapping),
      utilization: Number(util),
      resetsAt: parseResetsAt(getByPath(data, mapping.resetsAt), mapping.resetsAtFormat),
    })
    return windows
  }

  const arr = config.windowsPath ? getByPath(data, config.windowsPath) : data
  if (!Array.isArray(arr)) return []

  for (let i = 0; i < arr.length; i++) {
    const item = arr[i]
    const util = getByPath(item, mapping.utilization)
    if (util == null) continue
    const rawLabel = mapping.label.startsWith('=') ? mapping.label.slice(1) : (getByPath(item, mapping.label) ?? `Window ${i + 1}`)
    windows.push({
      key: mapping.key ? (getByPath(item, mapping.key) ?? `w${i}`) : `w${i}`,
      label: resolveLabel(rawLabel, mapping),
      utilization: Number(util),
      resetsAt: parseResetsAt(getByPath(item, mapping.resetsAt), mapping.resetsAtFormat),
    })
  }

  return windows
}

async function fetchCustomUsage(providerId: string, providerLabel: string, config: UsageProviderConfig): Promise<ProviderUsage> {
  const meta: ProviderMeta = { id: providerId, label: providerLabel, cli: providerId, vendor: providerLabel }

  const authHeaders = await resolveAuth(config)
  const res = await net.fetch(config.url, {
    method: config.method || 'GET',
    headers: {
      'Accept': 'application/json',
      ...authHeaders,
    },
  })

  if (res.status === 429) throw new RateLimitError(parseRetryAfter(res))
  if (!res.ok) return usageError(meta, httpError(res.status, meta))

  const data = await res.json()
  const windows = extractWindows(data, config)

  return { provider: providerId, label: providerLabel, windows, error: null, fetchedAt: Date.now() }
}

// Standalone test for usage config (no caching)
async function testUsageConfig(config: UsageProviderConfig): Promise<{ ok: boolean; windows?: UsageWindow[]; error?: string }> {
  try {
    const authHeaders = await resolveAuth(config)
    const res = await net.fetch(config.url, {
      method: config.method || 'GET',
      headers: { 'Accept': 'application/json', ...authHeaders },
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const data = await res.json()
    const windows = extractWindows(data, config)
    if (windows.length === 0) return { ok: false, error: 'No windows found — check response mapping' }
    return { ok: true, windows }
  } catch (e) {
    return { ok: false, error: friendlyError(e) }
  }
}

// ── Cache + backoff (per-provider) ──────────────────────────────────

const MIN_INTERVAL_MS = 10_000   // hard floor: never fetch faster than 10s apart
const DEFAULT_TTL_MS = 60_000    // auto-poll cache: 1 minute

interface CacheEntry {
  result: ProviderUsage
  cachedAt: number
  backoffUntil: number
  tokenHint?: string
}

const cache = new Map<string, CacheEntry>()
let inflight: Promise<ProviderUsage[]> | null = null
let lastFetchAt = 0

// Built-in provider IDs that have hardcoded fetchers
const BUILTIN_USAGE_IDS = new Set(['claude', 'codex'])

function fetchProvider(p: ProviderMeta, fetcher: () => Promise<ProviderUsage>, tokenHint?: string): Promise<ProviderUsage> {
  let existing = cache.get(p.id)

  // Account changed — discard stale data from different account
  if (existing && tokenHint && existing.tokenHint !== tokenHint) {
    cache.delete(p.id)
    existing = undefined
  }

  // Skip fetch if provider is in backoff — return cached result as-is
  if (existing && Date.now() < existing.backoffUntil) {
    return Promise.resolve(existing.result)
  }

  return fetcher().then((result) => {
    cache.set(p.id, {
      result,
      cachedAt: Date.now(),
      backoffUntil: existing?.backoffUntil ?? 0,
      tokenHint,
    })
    return result
  }).catch((e): ProviderUsage => {
    if (e instanceof RateLimitError) {
      const backoff = Math.max(e.retryAfterMs, MIN_BACKOFF_MS)
      const backoffUntil = Math.max(existing?.backoffUntil ?? 0, Date.now() + backoff)
      if (existing) {
        existing.backoffUntil = backoffUntil
      } else {
        cache.set(p.id, { result: usageError(p, 'Rate limited'), cachedAt: Date.now(), backoffUntil, tokenHint })
      }
    }
    const errorMsg = e instanceof RateLimitError ? e.message : friendlyError(e)
    // Preserve last valid windows so UI can show stale data + error indicator
    if (existing?.result.windows.length) {
      return { ...existing.result, error: errorMsg }
    }
    return usageError(p, errorMsg)
  })
}

// ── Handler ──────────────────────────────────────────────────────────

export function registerUsageHandlers(ipcMain: IpcMain, db: Database.Database): void {
  ipcMain.handle('usage:fetch', async (_e, force?: boolean): Promise<ProviderUsage[]> => {
    const now = Date.now()

    // Hard floor: never refetch within 10s (blocks spam-clicking)
    if (now - lastFetchAt < MIN_INTERVAL_MS && cache.size > 0) {
      return [...cache.values()].map(e => e.result)
    }

    // Auto-poll uses longer cache TTL
    if (!force && now - lastFetchAt < DEFAULT_TTL_MS && cache.size > 0) {
      return [...cache.values()].map(e => e.result)
    }

    // Deduplicate concurrent requests
    if (inflight) return inflight

    // Gather custom providers from DB
    const customRows = db.prepare(
      `SELECT id, label, usage_config FROM terminal_modes WHERE usage_config IS NOT NULL AND enabled = 1`
    ).all() as { id: string; label: string; usage_config: string }[]

    // Check enabled status for built-in providers
    const builtinEnabled = new Map(
      (db.prepare(
        `SELECT id, enabled FROM terminal_modes WHERE id IN ('claude-code', 'codex')`
      ).all() as { id: string; enabled: number }[]).map(r => [r.id, r.enabled === 1])
    )

    const fetchers: Promise<ProviderUsage>[] = []

    if (builtinEnabled.get('claude-code') !== false) {
      const claudeToken = await getClaudeToken()
      if (claudeToken) {
        fetchers.push(fetchProvider(CLAUDE, () => fetchClaudeUsageWithToken(claudeToken), claudeToken))
      } else {
        fetchers.push(Promise.resolve(usageError(CLAUDE, `Not logged in — run \`${CLAUDE.cli}\` to authenticate`)))
      }
    }

    if (builtinEnabled.get('codex') !== false) {
      const codexAuth = await getCodexAuth()
      if (codexAuth) {
        fetchers.push(fetchProvider(CODEX, () => fetchCodexUsageWithToken(codexAuth), codexAuth.accessToken))
      } else {
        fetchers.push(Promise.resolve(usageError(CODEX, `Not logged in — run \`${CODEX.cli}\` to authenticate`)))
      }
    }

    for (const row of customRows) {
      if (BUILTIN_USAGE_IDS.has(row.id)) continue
      try {
        const config: UsageProviderConfig = JSON.parse(row.usage_config)
        if (!config.enabled) continue
        const meta: ProviderMeta = { id: row.id, label: row.label, cli: row.id, vendor: row.label }
        fetchers.push(fetchProvider(meta, () => fetchCustomUsage(row.id, row.label, config)))
      } catch { /* skip corrupt config */ }
    }

    inflight = Promise.all(fetchers).then((results) => {
      lastFetchAt = Date.now()
      inflight = null
      return results
    }).catch((e) => {
      inflight = null
      throw e
    })

    return inflight
  })

  ipcMain.handle('usage:test', async (_e, config: UsageProviderConfig) => {
    return testUsageConfig(config)
  })
}
