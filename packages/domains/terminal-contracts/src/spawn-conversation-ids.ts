/**
 * The conversation ids a fresh AGENT spawn passes to `pty.create` — one rule for
 * every place that starts a task's agent (the desktop terminal, the hub's
 * `task.startMainAgent`), so the two cannot start the same session differently.
 *
 * A mode that can pre-mint (`supportsSessionId`: its `initialCommand` takes `{id}`,
 * see `supportsFreshPreMint`) gets a new id when the task has none to resume. That
 * id is only handed to the CLI (`--session-id {id}`), never persisted here: the
 * agent's SessionStart hook records it once the CLI confirms it, so a session that
 * dies first leaves no phantom id behind. Providers without `{id}` mint their own,
 * so an id from us would be bogus. A plain `terminal` carries neither.
 */
export function spawnConversationIds(
  opts: {
    mode: string
    supportsSessionId: boolean | undefined
    conversationId: string | null | undefined
    existingConversationId: string | null | undefined
  },
  mintId: () => string
): {
  conversationId: string | null | undefined
  existingConversationId: string | null | undefined
} {
  if (opts.mode === 'terminal')
    return { conversationId: undefined, existingConversationId: undefined }
  const mintFresh =
    opts.supportsSessionId === true && !opts.conversationId && !opts.existingConversationId
  return {
    conversationId: mintFresh ? mintId() : opts.conversationId,
    existingConversationId: opts.existingConversationId
  }
}
