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
import { StructuralFaultError } from '@slayzone/platform/isolation'
import { readJsonArraySalvage } from '@slayzone/platform/quarantine'

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
  const current = readHookJournal(runtimeDir, path)
  const old = readHookJournal(runtimeDir, legacy)
  const ids = new Set(current.map((event) => event.id))
  const merged = [...current, ...old.filter((event) => !ids.has(event.id))]
  writeHookJournal(path, merged)
  unlinkSync(legacy)
  syncDir(runtimeDir)
  return path
}

/** One journaled hook event awaiting the hub's acknowledgement. */
export interface HookJournalEvent {
  id: string
  params: unknown
}

/** Quarantine pass of journal bytes that could not be read (`<runtime>/quarantine/hook-journal`). */
export const HOOK_JOURNAL_QUARANTINE_PASS = 'hook-journal'

function parseHookEvent(value: unknown): HookJournalEvent {
  if (!value || typeof value !== 'object' || typeof (value as { id?: unknown }).id !== 'string')
    throw new StructuralFaultError('Invalid hook journal event')
  const event = value as { id: string; params?: unknown }
  return { id: event.id, params: event.params }
}

/**
 * Writes a journal durably, via the staging name session-host.ts `atomicRuntimeJson`
 * uses, so a crash leaves a temp the host's startup and offline erasure both
 * recognize and discard.
 */
export function writeHookJournal(path: string, events: HookJournalEvent[]): void {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temp, JSON.stringify(events) + '\n', { mode: 0o600, flush: true })
  renameSync(temp, path)
}

/**
 * A hub's hook journal. A torn or damaged journal must not stop the computer:
 * every event that still parses is kept (the journal is rewritten with them) and
 * the original bytes are quarantined, where erasure and Discard can reach them
 * (decision 7: salvage the readable part, quarantine the rest).
 */
export function readHookJournal(runtimeDir: string, path: string): HookJournalEvent[] {
  const read = readJsonArraySalvage(path, parseHookEvent, {
    root: runtimeDir,
    pass: HOOK_JOURNAL_QUARANTINE_PASS
  })
  if (read.status === 'salvaged') writeHookJournal(path, read.items)
  return read.items
}
