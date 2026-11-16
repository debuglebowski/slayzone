/**
 * File quarantine + tolerant JSON readers.
 *
 * A file or folder that cannot be read is moved (or its unreadable part copied)
 * into `<root>/quarantine/<pass>/<id>/payload` with a `meta.json` beside it. The
 * quarantine folder IS the durable record: listing it lists the faults, so there
 * is no second copy to drift, and a process without a database (the computer's
 * session host) can quarantine too. Discard deletes an entry; erasure deletes
 * every entry that names the erased task.
 */
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { forEachIsolatedSync, toError } from './isolation'

export const QUARANTINE_DIR = 'quarantine'
const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/

export interface QuarantineMeta {
  pass: string
  /** Where the payload came from; Retry moves it back there. */
  originalPath: string
  taskId: string | null
  reason: string
  at: number
}

export interface QuarantineEntry {
  pass: string
  id: string
  meta: QuarantineMeta | null
  payloadPath: string
}

function passDir(root: string, pass: string): string {
  if (!SAFE_SEGMENT.test(pass)) throw new Error(`Invalid quarantine pass name: ${pass}`)
  return join(root, QUARANTINE_DIR, pass)
}

function entryDir(root: string, pass: string, id: string): string {
  if (!SAFE_SEGMENT.test(id)) throw new Error(`Invalid quarantine id: ${id}`)
  return join(passDir(root, pass), id)
}

function writeMeta(dir: string, meta: QuarantineMeta): void {
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta))
}

/** Moves `path` (file or folder) into quarantine. Returns the entry id. */
export function quarantineMove(
  root: string,
  input: { pass: string; path: string; taskId?: string | null; reason: string }
): string {
  const id = randomUUID()
  const dir = entryDir(root, input.pass, id)
  mkdirSync(dir, { recursive: true })
  renameSync(input.path, join(dir, 'payload'))
  writeMeta(dir, {
    pass: input.pass,
    originalPath: input.path,
    taskId: input.taskId ?? null,
    reason: input.reason,
    at: Date.now()
  })
  return id
}

/** Stores bytes that could not be read (e.g. the unreadable rest of a salvaged journal). */
export function quarantineWrite(
  root: string,
  input: {
    pass: string
    originalPath: string
    content: string | Buffer
    taskId?: string | null
    reason: string
  }
): string {
  const id = randomUUID()
  const dir = entryDir(root, input.pass, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'payload'), input.content)
  writeMeta(dir, {
    pass: input.pass,
    originalPath: input.originalPath,
    taskId: input.taskId ?? null,
    reason: input.reason,
    at: Date.now()
  })
  return id
}

export function listQuarantine(root: string): QuarantineEntry[] {
  const base = join(root, QUARANTINE_DIR)
  if (!existsSync(base)) return []
  const out: QuarantineEntry[] = []
  for (const pass of readdirSync(base)) {
    const dir = join(base, pass)
    if (!SAFE_SEGMENT.test(pass) || !statSync(dir).isDirectory()) continue
    for (const id of readdirSync(dir)) {
      if (!SAFE_SEGMENT.test(id)) continue
      let meta: QuarantineMeta | null = null
      try {
        meta = JSON.parse(readFileSync(join(dir, id, 'meta.json'), 'utf8')) as QuarantineMeta
      } catch {
        // A crash between the move and the meta write: still listed, still discardable.
      }
      out.push({ pass, id, meta, payloadPath: join(dir, id, 'payload') })
    }
  }
  return out
}

/** Discard: permanent delete of one quarantined entry. */
export function discardQuarantine(root: string, pass: string, id: string): boolean {
  const dir = entryDir(root, pass, id)
  if (!existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

/**
 * Retry: moves the payload back to where it came from, so the next pass reads it
 * again. Refused when something new already lives there (never overwrites).
 */
export function restoreQuarantine(root: string, pass: string, id: string): boolean {
  const dir = entryDir(root, pass, id)
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as QuarantineMeta
  if (existsSync(meta.originalPath)) return false
  mkdirSync(dirname(meta.originalPath), { recursive: true })
  renameSync(join(dir, 'payload'), meta.originalPath)
  rmSync(dir, { recursive: true, force: true })
  return true
}

function containsBytes(path: string, needle: Buffer): boolean {
  let stat
  try {
    stat = statSync(path)
  } catch {
    return false
  }
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) {
      if (name.includes(needle.toString())) return true
      if (containsBytes(join(path, name), needle)) return true
    }
    return false
  }
  return readFileSync(path).includes(needle)
}

/**
 * Erasure: an unreadable payload cannot be inspected item by item, so every
 * quarantined entry whose meta or raw bytes name the task is deleted outright.
 */
export function eraseQuarantinedForTask(root: string, taskId: string): number {
  const needle = Buffer.from(taskId)
  // Every matching entry is attempted; any that remains fails the erasure after.
  const report = forEachIsolatedSync(
    listQuarantine(root).filter(
      (entry) => entry.meta?.taskId === taskId || containsBytes(entry.payloadPath, needle)
    ),
    { pass: 'quarantine-erasure', key: (entry) => `${entry.pass}/${entry.id}` },
    (entry) => {
      const dir = dirname(entry.payloadPath)
      rmSync(dir, { recursive: true, force: true })
      if (existsSync(dir)) throw new Error('Quarantined file remains')
    }
  )
  if (report.failed.length) throw report.failed[0].error
  return report.ok
}

/** `size:mtimeMs` — changes when a file is rewritten; lifts a structural quarantine. */
export function fileFingerprint(path: string): string | null {
  try {
    const s = statSync(path)
    return `${s.size}:${Math.trunc(s.mtimeMs)}`
  } catch {
    return null
  }
}

// ── Tolerant readers ─────────────────────────────────────────────────────────

export type TolerantRead<T> =
  | { status: 'missing' }
  | { status: 'ok'; value: T }
  | { status: 'corrupt'; error: Error; quarantineId: string }

/**
 * Reads a JSON file a process needs at startup. Missing → 'missing'. Unparsable
 * or rejected by `parse` → the file is moved into quarantine and 'corrupt' is
 * returned, so the caller starts from its default instead of refusing to boot.
 * Other read errors (EACCES, EIO) are rethrown: they are not the file's content.
 */
export function readJsonTolerant<T>(
  path: string,
  parse: (value: unknown) => T,
  quarantine: { root: string; pass: string }
): TolerantRead<T> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
    throw error
  }
  try {
    return { status: 'ok', value: parse(JSON.parse(text)) }
  } catch (raw) {
    const error = toError(raw)
    const quarantineId = quarantineMove(quarantine.root, {
      pass: quarantine.pass,
      path,
      reason: error.message
    })
    return { status: 'corrupt', error, quarantineId }
  }
}

/**
 * The complete top-level elements of a JSON array text, in order, up to the first
 * point the text stops being a well-formed array (a torn write, a bad byte).
 * Returns the raw element texts and whether the whole array was well-formed.
 */
export function scanJsonArrayElements(text: string): { elements: string[]; complete: boolean } {
  const elements: string[] = []
  let i = 0
  const n = text.length
  const ws = () => {
    while (i < n && /\s/.test(text[i])) i++
  }
  ws()
  if (text[i] !== '[') return { elements, complete: false }
  i++
  ws()
  if (text[i] === ']') {
    i++
    ws()
    return { elements, complete: i === n }
  }
  for (;;) {
    ws()
    const start = i
    let depth = 0
    let inString = false
    for (; i < n; i++) {
      const c = text[i]
      if (inString) {
        if (c === '\\') i++
        else if (c === '"') inString = false
        continue
      }
      if (c === '"') inString = true
      else if (c === '{' || c === '[') depth++
      else if (c === '}' || c === ']') {
        if (depth === 0) break
        depth--
      } else if (c === ',' && depth === 0) break
    }
    if (i >= n || inString || depth !== 0) return { elements, complete: false }
    const raw = text.slice(start, i).trim()
    try {
      JSON.parse(raw)
    } catch {
      return { elements, complete: false }
    }
    elements.push(raw)
    if (text[i] === ']') {
      i++
      ws()
      return { elements, complete: i === n }
    }
    i++ // ','
  }
}

export type SalvagedArray<T> =
  | { status: 'missing'; items: T[] }
  | { status: 'ok'; items: T[] }
  | { status: 'salvaged'; items: T[]; dropped: number; quarantineId: string }

/**
 * Reads a JSON-array journal, keeping every element that parses and validates.
 * When anything is unreadable (torn tail, invalid element, not an array) the
 * ORIGINAL bytes are copied into quarantine, so nothing is lost and erasure can
 * still find it; the caller rewrites the journal from the salvaged items.
 */
export function readJsonArraySalvage<T>(
  path: string,
  parseElement: (value: unknown) => T,
  quarantine: { root: string; pass: string }
): SalvagedArray<T> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing', items: [] }
    throw error
  }
  const { elements, complete } = scanJsonArrayElements(text)
  const items: T[] = []
  let dropped = 0
  for (const raw of elements) {
    try {
      items.push(parseElement(JSON.parse(raw)))
    } catch {
      dropped++
    }
  }
  if (complete && dropped === 0) return { status: 'ok', items }
  const quarantineId = quarantineWrite(quarantine.root, {
    pass: quarantine.pass,
    originalPath: path,
    content: text,
    reason: complete
      ? `${dropped} unreadable entr${dropped === 1 ? 'y' : 'ies'}`
      : `unreadable after entry ${elements.length}`
  })
  return { status: 'salvaged', items, dropped: dropped + (complete ? 0 : 1), quarantineId }
}
