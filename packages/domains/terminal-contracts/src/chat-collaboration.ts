/**
 * Collaboration mode for a chat session — the *behavioral* axis, orthogonal to
 * both the permission/runtime mode (`chat-mode-catalog.ts`) and reasoning
 * effort (`chat-effort.ts`).
 *
 * `plan`   — the agent investigates read-only and drafts a decision-complete
 *            plan instead of editing. Maps onto Codex's native `ModeKind: plan`.
 * `default`— normal build/execute behavior.
 *
 * Codex is currently the only provider with a collaboration-mode lever
 * (`turn/start.collaborationMode`); the dropdown is hidden for other modes.
 * Stored in `provider_config.<terminalMode>.chatCollaboration`.
 *
 * @module shared/chat-collaboration
 */

export type ChatCollaborationMode = 'default' | 'plan'

/** Ordered ids for the dropdown (build first, then plan). */
export const CHAT_COLLABORATION_MODES: ChatCollaborationMode[] = ['default', 'plan']

/** Value for a freshly created task when nothing has been persisted. */
export const DEFAULT_CHAT_COLLABORATION: ChatCollaborationMode = 'default'

export function isChatCollaborationMode(v: unknown): v is ChatCollaborationMode {
  return typeof v === 'string' && (CHAT_COLLABORATION_MODES as string[]).includes(v)
}

/**
 * Whether a terminal mode exposes the collaboration-mode lever. Only
 * `codex-chat` does — Claude's plan mode is a permission mode and lives in the
 * mode dropdown instead.
 */
export function modeSupportsCollaboration(mode: string): boolean {
  return mode === 'codex-chat'
}
