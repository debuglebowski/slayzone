/**
 * Control texts the chat UI sends as user messages (e.g. the plan-approval
 * markers `__slay_plan_approved__` / `__slay_plan_cancelled__`). They steer the
 * agent but are not prompts the user typed, so prompt history skips them.
 */
export function isSyntheticChatPrompt(text: string): boolean {
  return /^__slay_[a-z0-9_]+__$/.test(text.trim())
}
