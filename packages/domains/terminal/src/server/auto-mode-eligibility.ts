import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export interface AutoModeEligibility {
  /** Account on a plan that allows `--permission-mode auto` (Max/Team/Enterprise). */
  eligible: boolean
  /** User has acknowledged the one-time opt-in prompt. */
  optedIn: boolean
}

const ELIGIBLE_ORG_TYPES = new Set(['claude_max', 'claude_team', 'claude_enterprise'])

/**
 * Detect whether `--permission-mode auto` is usable WITHOUT spawning a Claude
 * CLI session. Reads two files written by claude-code itself:
 *
 *   - `~/.claude.json`              — global state. We check `oauthAccount.organizationType`
 *                                     (plan eligibility) and `hasResetAutoModeOptInForDefaultOffer`
 *                                     (one signal of opt-in).
 *   - `~/.claude/settings.json`     — user settings. `permissions.defaultMode === 'auto'`
 *                                     and `skipAutoPermissionPrompt === true` are positive
 *                                     opt-in signals.
 *
 * The cached GrowthBook gate (`tengu_auto_mode_config.enabled`) is intentionally
 * skipped — it's a stale server response and `organizationType` is the more
 * reliable first-pass eligibility check.
 *
 * Fail-soft: any I/O or parse error → both flags false (treat as unavailable).
 *
 * Result is cached for the lifetime of the process. Opt-in status can only
 * change by running `claude` from a terminal and accepting a prompt; users who
 * do this can restart SlayZone to refresh.
 */
let cached: AutoModeEligibility | null = null

export async function getAutoModeEligibility(): Promise<AutoModeEligibility> {
  if (cached) return cached
  cached = await read()
  return cached
}

/** Test-only: drop the in-process cache. */
export function _resetAutoModeEligibilityCache(): void {
  cached = null
}

async function read(): Promise<AutoModeEligibility> {
  const home = os.homedir()
  const [globalRaw, settingsRaw] = await Promise.all([
    safeRead(path.join(home, '.claude.json')),
    safeRead(path.join(home, '.claude', 'settings.json')),
  ])
  const global = parseJson(globalRaw)
  const settings = parseJson(settingsRaw)

  const orgType = pickString(global, ['oauthAccount', 'organizationType'])
  const eligible = orgType != null && ELIGIBLE_ORG_TYPES.has(orgType)

  const defaultMode = pickString(settings, ['permissions', 'defaultMode'])
  const skipAutoPrompt = pickBool(settings, ['skipAutoPermissionPrompt'])
  const optInFlag = pickBool(global, ['hasResetAutoModeOptInForDefaultOffer'])
  const optedIn = defaultMode === 'auto' || skipAutoPrompt === true || optInFlag === true

  return { eligible, optedIn: eligible && optedIn }
}

async function safeRead(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf-8')
  } catch {
    return null
  }
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function pickString(obj: unknown, keyPath: string[]): string | null {
  const v = pick(obj, keyPath)
  return typeof v === 'string' ? v : null
}

function pickBool(obj: unknown, keyPath: string[]): boolean | null {
  const v = pick(obj, keyPath)
  return typeof v === 'boolean' ? v : null
}

function pick(obj: unknown, keyPath: string[]): unknown {
  let cur: unknown = obj
  for (const k of keyPath) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}
