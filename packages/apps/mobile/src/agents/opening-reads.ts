/**
 * "Opening a task marks it read" happens once per OPENING, not once per mount: the
 * agent panel remounts within one opening (the page switches layout, a part of it is
 * shown again), and marking it read again then would undo the user's "Mark as unread".
 * The page that opens the task names the opening (`AgentPanel`'s `openingKey`); this
 * remembers which openings have marked their task read.
 */

/** Openings remembered; the oldest are forgotten past this (each is a few bytes). */
const KEPT = 500
const claimed = new Set<string>()

/** True the first time `opening` asks: it is the one to mark its task read. */
export function claimOpening(opening: string): boolean {
  if (claimed.has(opening)) return false
  claimed.add(opening)
  if (claimed.size > KEPT) claimed.delete(claimed.values().next().value as string)
  return true
}
