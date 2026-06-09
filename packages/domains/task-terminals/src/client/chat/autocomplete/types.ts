import type { ReactNode } from 'react'
import type { SkillInfo, CommandInfo, AgentInfo, FileMatch } from '@slayzone/terminal/shared'

export interface TriggerMatch {
  /** The query string the user has typed after the trigger char(s). */
  query: string
  /** Index in `draft` where the replaceable token begins (usually at or before cursor). */
  tokenStart: number
  /** Index in `draft` where the replaceable token ends (typically cursorPos). */
  tokenEnd: number
}

export interface FetchCtx {
  cwd: string
}

export interface SessionRef {
  tabId: string
  taskId: string
  mode: string
  cwd: string
  providerFlagsOverride?: string | null
}

export interface ChatActions {
  kill: (tabId: string) => Promise<void>
  /** Delete the session from the main-side map so a subsequent `hydrate` spawns fresh. */
  remove: (tabId: string) => Promise<void>
  /**
   * Atomic reset: kill + wipe persisted events + clear stored conversation id +
   * re-hydrate a fresh skeleton (no spawn — lazy). Next `send` triggers the
   * subprocess.
   */
  reset: (opts: {
    tabId: string
    taskId: string
    mode: string
    cwd: string
    providerFlagsOverride?: string | null
  }) => Promise<unknown>
  /** Lazy hydrate: load persisted buffer + metadata, no subprocess spawn. */
  hydrate: (opts: {
    tabId: string
    taskId: string
    mode: string
    cwd: string
    providerFlagsOverride?: string | null
  }) => Promise<unknown>
  /** Eager spawn (Restart button). Hydrate + ensureSpawned. */
  start: (opts: {
    tabId: string
    taskId: string
    mode: string
    cwd: string
    providerFlagsOverride?: string | null
  }) => Promise<unknown>
  send: (tabId: string, text: string) => Promise<boolean>
  interrupt: (opts: {
    tabId: string
    taskId: string
    mode: string
    cwd: string
    providerFlagsOverride?: string | null
  }) => Promise<unknown>
}

export interface NavigateActions {
  openSettings: (tab?: string) => void
  openExternal: (url: string) => void
  openFile: (path: string) => void
}

/**
 * Project-metadata lookups the autocomplete sources need (skills / commands /
 * agents / file matches). Threaded into each source factory by `useChatComposer`
 * (built from the tRPC client) so the plain factory functions stay React-free
 * and testable — passing `undefined` makes every `fetch` resolve to `[]`,
 * mirroring the previous null-guarded `window.api.chat` access.
 */
export interface ChatListApi {
  listSkills: (cwd: string) => Promise<SkillInfo[]>
  listCommands: (cwd: string) => Promise<CommandInfo[]>
  listAgents: (cwd: string) => Promise<AgentInfo[]>
  listFiles: (cwd: string, query: string, limit?: number) => Promise<FileMatch[]>
}

export interface AcceptCtx {
  draft: string
  setDraft: (v: string) => void
  tokenStart: number
  tokenEnd: number
  session: SessionRef
  chat: ChatActions
  navigate: NavigateActions
  toast: (msg: string) => void
}

export interface SubmitTransform {
  /** Replacement text to actually send. Empty string = don't send, clear draft. */
  send: string | null
  /** Optional side-effect (e.g. toast). */
  afterTransform?: (ctx: AcceptCtx) => void | Promise<void>
}

export interface AutocompleteSource<Item = unknown> {
  id: string
  /** Detect whether this source applies to the current draft/cursor. Returns token slice to replace on accept. */
  detect: (draft: string, cursorPos: number) => TriggerMatch | null
  fetch: (ctx: FetchCtx) => Promise<Item[]>
  filter: (items: Item[], query: string) => Item[]
  getKey: (item: Item) => string
  render: (item: Item, selected: boolean) => ReactNode
  accept: (item: Item, ctx: AcceptCtx) => void | Promise<void>
  /**
   * Optional pre-send transformer. Called by ChatPanel.handleSend before sending.
   * Return `send: null` to pass through. Return `send: string` to override outgoing text.
   * Use for slash commands that expand templates on Enter (e.g. `/review $ARGUMENTS`).
   */
  transformSubmit?: (draft: string, items: Item[]) => SubmitTransform | null
  /**
   * Accessors for cross-source merge ranking. When two or more sources detect at the same
   * token range AND expose `getName`, useAutocomplete merges their items into one fzf-ranked
   * list instead of letting the first source's results shadow the rest.
   */
  getName?: (item: Item) => string
  getDescription?: (item: Item) => string
}

export type AnyItem = SkillInfo | CommandInfo | AgentInfo | BuiltinCommand | FileMatch

export interface BuiltinCommand {
  name: string
  description: string
  run: (ctx: AcceptCtx) => void | Promise<void>
}
