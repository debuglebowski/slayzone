import { resolveCitedPath } from './codex-file-citations'

/**
 * What a link in a rendered chat message opens. Every anchor click in the chat
 * goes through here and is cancelled: a click the browser follows replaces the
 * whole app window with the link target (a file-path link loaded the dev server
 * at that path; a blanked link reloaded the app).
 */
export type ChatLink =
  | { kind: 'thread'; id: string }
  /** http(s): honours the ⌘ (in-app browser) / ⌘⇧ (external) modifiers. */
  | { kind: 'web'; url: string }
  /** Any other scheme the OS opens (mailto). */
  | { kind: 'external'; url: string }
  /** `artifact:<id>` — full id or a short prefix. */
  | { kind: 'artifact'; ref: string }
  /** `slayzone://task/<id>` — full id or a short prefix. */
  | { kind: 'task'; ref: string }
  /** A local file: absolute, relative to the chat's cwd, or `file://`. */
  | { kind: 'file'; path: string; line?: number; col?: number }
  | { kind: 'none' }

const SCHEME = /^([a-z][a-z0-9+.-]*):/i
/** `path:12` or `path:12:3` (the form agents cite code in). */
const COLON_LINE = /^(.+?):(\d+)(?::(\d+))?$/
/** GitHub-style `path#L12`, `path#L12C3`, `path#L12-L20`. */
const HASH_LINE = /^(.+?)#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/
/** A Windows drive path (`C:\x`, `C:/x`) — a path, not a URL scheme. */
const DRIVE = /^[A-Za-z]:[\\/]/

function decode(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

function fileLink(raw: string): ChatLink {
  const m = HASH_LINE.exec(raw) ?? COLON_LINE.exec(raw)
  const path = decode(m ? m[1] : raw)
  if (!path) return { kind: 'none' }
  const link: ChatLink = { kind: 'file', path }
  if (m) {
    link.line = Number(m[2])
    if (m[3]) link.col = Number(m[3])
  }
  return link
}

export function classifyChatLink(href: string): ChatLink {
  if (!href) return { kind: 'none' }
  if (href.startsWith('#')) {
    if (href.startsWith('#chat-thread:')) {
      const id = href.slice('#chat-thread:'.length)
      return id ? { kind: 'thread', id } : { kind: 'none' }
    }
    return { kind: 'none' }
  }
  if (DRIVE.test(href)) return fileLink(href)
  const scheme = SCHEME.exec(href)?.[1]?.toLowerCase()
  switch (scheme) {
    case 'http':
    case 'https':
      return { kind: 'web', url: href }
    case 'mailto':
      return { kind: 'external', url: href }
    case 'artifact': {
      const ref = href.slice('artifact:'.length).trim()
      return ref ? { kind: 'artifact', ref } : { kind: 'none' }
    }
    case 'slayzone': {
      const m = /^slayzone:\/\/task\/([^/?#]+)\/?$/i.exec(href)
      return m ? { kind: 'task', ref: m[1] } : { kind: 'none' }
    }
    case 'file':
      return fileLink(href.replace(/^file:\/\/(localhost)?/i, ''))
  }
  // `name.ts:105` also matches SCHEME; a line suffix makes it a path.
  if (COLON_LINE.test(href) || HASH_LINE.test(href)) return fileLink(href)
  if (scheme) return { kind: 'none' }
  return fileLink(href)
}

/** Exact id, else the one id the prefix picks out; null when unknown or ambiguous. */
export function resolveIdRef(ref: string, ids: Iterable<string>): string | null {
  if (!ref) return null
  let match: string | null = null
  let ambiguous = false
  for (const id of ids) {
    if (id === ref) return id
    if (id.startsWith(ref)) {
      ambiguous = match !== null
      match ??= id
    }
  }
  return ambiguous ? null : match
}

export interface ChatLinkClick {
  href: string
  /** `data-file-citation-path` of a Codex file-citation chip. */
  citedPath?: string
  /** `data-link-base` of the nearest container: the page a fetched summary came from. */
  base?: string
  /** ⌘/Ctrl held. */
  mod: boolean
  shift: boolean
}

export interface ChatLinkActions {
  cwd: string
  openThread: (id: string) => void
  openFile: (absPath: string, line?: number, col?: number) => void
  openArtifact?: (ref: string) => void
  openTask?: (ref: string) => void
  /** In-app browser (⌘+click on a web link). */
  openUrl?: (url: string) => void
  openExternal: (url: string) => void
}

/** Resolve a path-like href against the page it was fetched from; null when not one. */
function resolveAgainstBase(href: string, base: string | undefined): string | null {
  if (!base || !href || href.startsWith('#') || SCHEME.test(href)) return null
  try {
    const url = new URL(href, base)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/**
 * Open what a chat link points at. The caller cancels the browser's default for
 * every anchor (see `ChatLink`), so a link this cannot place opens nothing.
 */
export function openChatLink(click: ChatLinkClick, actions: ChatLinkActions): void {
  if (click.citedPath && !/^https?:\/\//i.test(click.citedPath)) {
    actions.openFile(resolveCitedPath(click.citedPath, actions.cwd))
    return
  }
  const fromBase = resolveAgainstBase(click.href, click.base)
  const link: ChatLink = fromBase ? { kind: 'web', url: fromBase } : classifyChatLink(click.href)
  switch (link.kind) {
    case 'thread':
      actions.openThread(link.id)
      return
    case 'web':
      if (click.mod && !click.shift && actions.openUrl) actions.openUrl(link.url)
      else actions.openExternal(link.url)
      return
    case 'external':
      actions.openExternal(link.url)
      return
    case 'artifact':
      actions.openArtifact?.(link.ref)
      return
    case 'task':
      actions.openTask?.(link.ref)
      return
    case 'file':
      actions.openFile(resolveCitedPath(link.path, actions.cwd), link.line, link.col)
      return
    case 'none':
      return
  }
}
