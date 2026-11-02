/**
 * A side question (`/btw`): asked about the conversation, answered from it, and
 * never part of it — the main session's transcript and its running turn stay
 * as they are. Claude answers it natively (`side_question` control request);
 * Codex from an ephemeral fork of the thread.
 */

/** One earlier exchange of the same side discussion (follow-ups see it). */
export interface SideQuestionExchange {
  question: string
  answer: string
}

export interface SideQuestionRequest {
  /** Client-minted; names the question for `cancelSideQuestion`. */
  requestId: string
  question: string
  /** Earlier exchanges of this side discussion, oldest first. */
  history: SideQuestionExchange[]
}

export interface SideAnswer {
  /** The answer; null when the agent gave none. */
  text: string | null
}

/** Longest a side question may run before it is given up. */
export const SIDE_QUESTION_TIMEOUT_MS = 180_000

/** Longest question accepted (the CLIs bound prompt size themselves too). */
export const SIDE_QUESTION_MAX_CHARS = 20_000
