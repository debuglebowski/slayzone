/**
 * Where a computer journals one hub's agent-hook events until the hub acknowledges
 * them (session-host.ts `SessionTransport`), and the ONE definition of that file's
 * name — the live host and offline erasure (offline-erasure.ts) both resolve it here.
 *
 * NAMED BY THE CANONICAL HUB URL: `hooks-<sha256(canonical url) hex, 16 chars>.json`.
 * The name used to hash the configured URL string verbatim, so two spellings of one
 * hub (`…/computers/`, `WSS://Hub.example:443/computers`) named two files — and an
 * offline cleanup given another spelling than the computer's configuration passed the
 * hub check yet missed the journal, reporting it erased. The canonical form folds what
 * a URL parser already treats as the same (scheme and host case, a default port) plus
 * trailing slashes. A usual URL (`wss://hub.example/computers`) is its own canonical
 * form, so its file keeps its name; a file under another spelling is renamed on the
 * host's next start ({@link adoptHookJournal}).
 *
 * @module computer/hook-journal
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

/** A published journal file (not a staging temp): `hooks-<16 hex>.json`. */
export const HOOK_JOURNAL_FILE = /^hooks-[a-f0-9]{16}\.json$/

/** The hub URL as the journal is named by. An unparseable URL stays as given. */
export function canonicalHookJournalUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`
}

const nameOf = (key: string): string =>
  'hooks-' + createHash('sha256').update(key).digest('hex').slice(0, 16) + '.json'

/** The journal of the hub at `hubUrl`, any spelling of it. */
export function hookJournalPath(runtimeDir: string, hubUrl: string): string {
  return join(runtimeDir, nameOf(canonicalHookJournalUrl(hubUrl)))
}

/** Where a host before the canonical name kept it: the URL string verbatim. */
export function legacyHookJournalPath(runtimeDir: string, hubUrl: string): string {
  return join(runtimeDir, nameOf(hubUrl))
}

function syncDir(dir: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(dir, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * The journal path for `hubUrl`, with a file an older host left under the verbatim
 * spelling moved to it first. Both present (a downgrade wrote the old one meanwhile):
 * merged by event id, the canonical file's order first, then the old one is removed.
 */
export function adoptHookJournal(runtimeDir: string, hubUrl: string): string {
  const path = hookJournalPath(runtimeDir, hubUrl)
  const legacy = legacyHookJournalPath(runtimeDir, hubUrl)
  if (legacy === path || !existsSync(legacy)) return path
  if (!existsSync(path)) {
    renameSync(legacy, path)
    syncDir(runtimeDir)
    return path
  }
  const current: Array<{ id: string }> = JSON.parse(readFileSync(path, 'utf8'))
  const old: Array<{ id: string }> = JSON.parse(readFileSync(legacy, 'utf8'))
  if (!Array.isArray(current) || !Array.isArray(old)) throw new Error('Invalid host event journal')
  const ids = new Set(current.map((event) => event.id))
  const merged = [...current, ...old.filter((event) => !ids.has(event.id))]
  // The staging name session-host.ts `atomicRuntimeJson` uses, so a crash here leaves
  // a temp the host's startup and offline erasure both recognize and discard.
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temp, JSON.stringify(merged) + '\n', { mode: 0o600, flush: true })
  renameSync(temp, path)
  unlinkSync(legacy)
  syncDir(runtimeDir)
  return path
}
