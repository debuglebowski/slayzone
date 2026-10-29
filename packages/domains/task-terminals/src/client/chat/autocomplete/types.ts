import type { ReactNode } from 'react'
import type {
  SkillInfo,
  CommandInfo,
  AgentInfo,
  FileMatch,
  ChatCapabilities
} from '@slayzone/terminal-contracts'

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
  /**
   * Eager spawn (Restart button, auto-start). Hydrate + ensureSpawned; resolves
   * once the agent is ready, rejects when it could not start. `reason: 'restore'`
   * starts it in the computer's background lane (reopening a workspace).
   */
  start: (opts: {
    tabId: string
    taskId: string
    mode: string
    cwd: string
    providerFlagsOverride?: string | null
    reason?: 'user' | 'restore'
  }) => Promise<unknown>
  /** Raw send (no queue, no optimistic bubble). Prefer `AcceptCtx.submit`. */
  send: (tabId: string, text: string) => Promise<{ id: string; state: string }>
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
 * mirroring the previous null-guarded preload chat access.
 */
export interface ChatListApi {
  listSkills: (cwd: string) => Promise<SkillInfo[]>
  /** `nested` adds sub-folder commands under their CLI name (`sub/z.md` → `sub:z`). */
  listCommands: (cwd: string, opts?: { nested?: boolean }) => Promise<CommandInfo[]>
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
  /**
   * Send text as the user would: queued behind a running turn, shown at once,
   * tracked to delivery. What a command that sends a prompt should use.
   */
  submit: (text: string) => Promise<void>
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
  /**
   * The source completes a `/command` token at the start of the draft. With the
   * `native-commands` Enter policy, Enter on such a match follows `resolveEnter`
   * (exact name → that entry, unknown → pass the draft through).
   */
  commandTrigger?: boolean
  /** Hide items whose name an item of one of these sources (by id) already has. */
  shadowedBy?: string[]
  /**
   * Text to SEND when Enter picks this item under the `native-commands` policy
   * (e.g. `/compact` for a CLI command). Null or absent → `accept()` instead.
   */
  submitText?: (item: Item, ctx: AcceptCtx) => string | null
}

export type AnyItem = SkillInfo | CommandInfo | AgentInfo | BuiltinCommand | FileMatch

export interface BuiltinCommand {
  name: string
  description: string
  /**
   * When the chat CLI advertises a command of the same name: `app-wins` keeps
   * this builtin (it owns app state or opens app UI — the CLI's version would
   * bypass or desync it); `cli-wins` hides it so the CLI's native command runs
   * (this builtin is only a fallback for CLIs that lack it).
   */
  cliCollision: 'app-wins' | 'cli-wins'
  /** Offered only when this returns true for the mode's capabilities (default: always). */
  available?: (caps: ChatCapabilities) => boolean
  run: (ctx: AcceptCtx) => void | Promise<void>
}
