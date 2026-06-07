/**
 * Pure fresh-vs-resume decision for a PTY spawn. Extracted from `createPty` so
 * the core invariant is a named, unit-tested function (mirrors the codebase's
 * other pure decisions: `decideReviveMode`, `decideConversationHeal`,
 * `shouldHonorDetectedError`).
 *
 * THE INVARIANT (the restart-clobber regression guard): if a conversation is
 * known — either via the renderer hint OR resolved from the ledger by main —
 * the spawn RESUMES it and NEVER mints a fresh session over it. A fresh mint is
 * only legitimate when no id is known anywhere AND the provider supports it.
 *
 * Side effects (the ledger read, the healer, the actual UUID mint) live in
 * `createPty`; this function only decides, from already-gathered inputs.
 */
export interface SpawnConversationInput {
  /** Conversation id hint the renderer passed (`existingConversationId`). May be
   *  null/undefined on boot before the board store hydrates — which is exactly
   *  the case that used to cause the clobber. */
  existingConversationId?: string | null
  /** Authoritative id main resolved from the `task_conversations` ledger. Null
   *  when there is none, or after a manual-reset cutoff. */
  ledgerConversationId?: string | null
  /** Explicit conversation id passed directly to the spawn (separate from the
   *  resume target — gates minting, never resumed on its own here). */
  conversationId?: string | null
  /** Whether the provider's `initialCommand` has the `{id}` placeholder
   *  (claude-code, qwen-code). Only those pre-mint a fresh session id. */
  supportsFreshPreMint: boolean
}

export interface SpawnConversationDecision {
  /** Id to resume (pre-heal). Renderer hint wins, then the ledger. Null => no
   *  resume target. */
  resolvedExistingId: string | null
  /** True when there is a resume target (→ use the resume template). */
  resuming: boolean
  /** True when main should mint a brand-new session id (a legitimate fresh
   *  start). Structurally false whenever any id is known. */
  shouldMintFresh: boolean
}

export function resolveSpawnConversation(input: SpawnConversationInput): SpawnConversationDecision {
  // Renderer hint takes precedence (it may already reflect a just-detected id);
  // otherwise fall back to the ledger. Empty string is treated as absent.
  const resolved = input.existingConversationId || input.ledgerConversationId || null
  const resuming = !!resolved
  // Mint ONLY when nothing is known and the provider supports pre-mint. The
  // `!conversationId` guard preserves the original behaviour: an explicit
  // conversationId is not overwritten by a fresh mint.
  const shouldMintFresh = !resuming && !input.conversationId && input.supportsFreshPreMint
  return { resolvedExistingId: resolved, resuming, shouldMintFresh }
}
