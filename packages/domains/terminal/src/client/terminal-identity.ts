/**
 * Cross-task terminal leak detector.
 *
 * Reported symptom (unconfirmed): a task's terminal shows ANOTHER task's output,
 * persistently (survives a task switch), while its own agent keeps working. A
 * task switch repaints from the xterm buffer, so stale pixels are ruled out —
 * either the wrong bytes reached this session's server buffer, or the pane holds
 * / renders the wrong xterm instance. This module catches the second class.
 *
 * Every xterm root is tagged with its session id at open (`tagTerminalElement`).
 * A pane must hold exactly ONE xterm root, tagged with the pane's own session id,
 * and the pane's terminal ref must be that root. Any deviation is reported once
 * per (session, anomaly) as `terminal.identity_mismatch` in `diagnostics_events`.
 *
 * Distinguishing the first class (server buffer contaminated): reload the window
 * — every terminal rebuilds from its server buffer; a leak that survives is there.
 */
import { getTrpcClient } from '@slayzone/transport/client'
import type { Terminal as XTerm } from '@xterm/xterm'

const TAG_ATTR = 'data-slz-session'

export type IdentityAnomaly =
  | 'no-xterm-in-container'
  | 'multiple-xterms'
  | 'foreign-xterm-in-container'
  | 'terminal-ref-foreign'
  | 'terminal-not-in-container'
  | 'cached-foreign-terminal'

export interface IdentityInput {
  sessionId: string
  /** Session tag of every `.xterm` root inside the pane (null = untagged). */
  containerTags: Array<string | null>
  /** Tag on the pane's terminal ref root; undefined = no terminal yet. */
  terminalTag: string | null | undefined
  terminalInContainer: boolean
}

/** Pure — exported for tests. */
export function findIdentityAnomalies(input: IdentityInput): IdentityAnomaly[] {
  const { sessionId, containerTags, terminalTag, terminalInContainer } = input
  const out: IdentityAnomaly[] = []
  const hasTerminal = terminalTag !== undefined
  if (containerTags.length === 0 && hasTerminal) out.push('no-xterm-in-container')
  if (containerTags.length > 1) out.push('multiple-xterms')
  if (containerTags.some((t) => t !== sessionId)) out.push('foreign-xterm-in-container')
  if (hasTerminal) {
    if (terminalTag !== sessionId) out.push('terminal-ref-foreign')
    if (!terminalInContainer) out.push('terminal-not-in-container')
  }
  return out
}

export function tagTerminalElement(terminal: XTerm, sessionId: string): void {
  terminal.element?.setAttribute(TAG_ATTR, sessionId)
}

function tagOf(el: Element | null | undefined): string | null {
  return el?.getAttribute(TAG_ATTR) ?? null
}

const reported = new Set<string>()

function report(
  sessionId: string,
  site: string,
  anomalies: IdentityAnomaly[],
  payload: Record<string, unknown>
): void {
  const fresh = anomalies.filter((a) => !reported.has(`${sessionId}|${a}`))
  if (fresh.length === 0) return
  for (const a of fresh) reported.add(`${sessionId}|${a}`)
  const full = { site, anomalies, ...payload }
  console.warn(`[terminal] identity mismatch ${sessionId} @${site}`, full)
  try {
    void getTrpcClient()
      .diagnostics.recordClientEvent.mutate({
        event: 'terminal.identity_mismatch',
        level: 'error',
        sessionId,
        message: `terminal pane ${sessionId} holds a foreign/extra xterm (${anomalies.join(', ')}) @${site}`,
        payload: full
      })
      .catch(() => {
        // Diagnostics must never break the terminal.
      })
  } catch {
    // Diagnostics must never break the terminal.
  }
}

/** Check a mounted pane. Cheap (one querySelectorAll). */
export function checkTerminalIdentity(
  sessionId: string,
  container: HTMLElement | null,
  terminal: XTerm | null,
  site: string
): void {
  if (!container) return
  const roots = Array.from(container.querySelectorAll('.xterm'))
  const terminalEl = terminal?.element
  const anomalies = findIdentityAnomalies({
    sessionId,
    containerTags: roots.map(tagOf),
    terminalTag: terminal ? tagOf(terminalEl) : undefined,
    terminalInContainer: !!terminalEl && container.contains(terminalEl)
  })
  if (anomalies.length === 0) return
  report(sessionId, site, anomalies, {
    containerTags: roots.map(tagOf),
    terminalTag: terminal ? tagOf(terminalEl) : null,
    terminalRows: terminal ? readTail(terminal) : null
  })
}

/** Check an instance about to be filed in the terminal cache under `sessionId`. */
export function checkCachedIdentity(sessionId: string, element: HTMLElement): void {
  const tag = tagOf(element)
  if (tag === sessionId) return
  report(sessionId, 'cache', ['cached-foreign-terminal'], { cachedTag: tag })
}

/** Last visible rows as text — what the user would see, for the report. */
function readTail(terminal: XTerm, rows = 8): string[] {
  try {
    const buf = terminal.buffer.active
    const end = buf.baseY + buf.cursorY
    const out: string[] = []
    for (let y = Math.max(0, end - rows + 1); y <= end; y++) {
      out.push(buf.getLine(y)?.translateToString(true) ?? '')
    }
    return out
  } catch {
    return []
  }
}

/** Test seam. */
export function __resetIdentityReportsForTest(): void {
  reported.clear()
}
