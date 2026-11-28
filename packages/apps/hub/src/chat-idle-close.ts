import type { ChatHibernateCheck } from "@slayzone/computer-transport/shared";

/**
 * Idle-close's pure core, shared by the hub's pty sweep and computer chats.
 *
 * Ptys: the hub sweeps its own mirrored sessions (`startIdleChecker`). Chats live on
 * computers, so the computer sweeps them: it asks the hub's window (`chat.idlePolicy`
 * → {@link idleCloseWindowMs}), and before each hibernation asks again
 * (`chat.hibernateCheck`, `reason: 'idle'` → {@link chatIdleCloseAllows}). The window
 * is the user's setting alone; the computer's own `idleBeforeHibernateMs` only gates
 * memory reclamation (docs/computer-resources.md).
 */

export type IdleCloseConfig = { enabled: boolean; idleMs: number };

/** The pty sweep's floor too (`isHibernateEligible`): a window below it is clamped. */
const MIN_IDLE_CLOSE_MS = 5_000;

/**
 * The user's idle-close setting (`terminal_auto_close_idle` / `_value` / `_unit`).
 * Raw `=== '1'` (NOT isLabEnabled, which defaults ON in dev) keeps it strictly opt-in.
 */
export function readIdleCloseConfig(
  get: (key: string) => string | null | undefined,
): IdleCloseConfig {
  const value = Number(get("terminal_idle_close_value")) || 30;
  const unit = get("terminal_idle_close_unit") || "minutes";
  const unitMs =
    unit === "seconds" ? 1_000 : unit === "hours" ? 3_600_000 : 60_000;
  return {
    enabled: get("terminal_auto_close_idle") === "1",
    idleMs: value * unitMs,
  };
}

/** What `chat.idlePolicy` announces: the window, or null when idle-close is off. */
export function idleCloseWindowMs(config: IdleCloseConfig): number | null {
  return config.enabled ? Math.max(MIN_IDLE_CLOSE_MS, config.idleMs) : null;
}

/**
 * The hub's re-check when a computer wants to hibernate an idle chat. Memory
 * reclamation (`pressure`) is the computer's call and passes. `idle` passes only if
 * the setting is still on, the chat is idle past the CURRENT window, and nobody
 * engaged with the task (`engagedAt`, e.g. the browser panel) inside it — the same
 * user-axis the pty sweep keeps (`shouldHibernate`).
 */
export function chatIdleCloseAllows(
  check: ChatHibernateCheck,
  config: IdleCloseConfig,
  engagedAt: number | undefined,
  now: number,
): boolean {
  if (check.reason !== "idle") return true;
  const windowMs = idleCloseWindowMs(config);
  if (windowMs === null) return false;
  if (check.idleForMs === undefined || check.idleForMs < windowMs) return false;
  return engagedAt === undefined || now - engagedAt >= windowMs;
}
