/**
 * Who may control a live chat process (interrupt, abort, kill, remove) through the
 * hub chat relay — asked by the relay BEFORE it stamps the owner task's path scope on
 * a control frame (chat-runtime `hub-relay.ts`, `authorizeControl`). The scope is the
 * relay's own authority toward the computer, so a caller must first hold it: no
 * confused deputy (task 3ee12d11).
 *
 * THE DECISION is `canAccess` (`@slayzone/api` access.ts), the same one the tRPC owner
 * gate makes for `chat.kill` / `chat.interrupt` (`tab('tabId')` at `edit`): the chat's
 * tab is on a computer, so it is its one owner user's — never shared. A tab row
 * already gone (a chat removed with its tab) falls back to the task's owner user.
 *
 * The caller is the request's security context. No context, or a null actor, is the
 * hub acting on its own behalf (lifecycle stops, cleanup, access-change stops) — the
 * gateway's own convention; on a hub with login every user request carries a verified
 * actor. A hub without login: everyone may (its one local user).
 *
 * @module hub/chat-control-authority
 */
import { canAccess, type OwnedResource } from '@slayzone/api'
import type { SlayzoneDb } from '@slayzone/platform'
import { isHubLoginRequired } from '@slayzone/platform/hub-switches'
import { currentSecurityContext } from '@slayzone/platform/security-log'
import type { HubChatOwnership } from '@slayzone/chat-runtime/server'

/** The caller may not control this chat. */
export class ChatControlForbiddenError extends Error {
  constructor(readonly taskId: string) {
    super(`Not allowed to control the agent of task ${taskId}`)
    this.name = 'ChatControlForbiddenError'
  }
}

export function createChatControlAuthorizer(
  db: SlayzoneDb,
  /** Whether this hub requires login. Default: from env. */
  loginRequired: () => boolean = isHubLoginRequired
): (owner: Pick<HubChatOwnership, 'taskId' | 'tabId'>) => Promise<void> {
  return async (owner) => {
    const actor = currentSecurityContext()?.actor ?? null
    if (actor === null) return
    const tab = await db.get<{ id: string }>('SELECT id FROM terminal_tabs WHERE id = ?', [
      owner.tabId
    ])
    const resource: OwnedResource = tab
      ? { kind: 'tab', id: owner.tabId }
      : { kind: 'taskOwner', id: owner.taskId }
    const allowed = await canAccess(
      db,
      { authRequired: loginRequired(), principal: { userId: actor } },
      resource,
      'edit'
    )
    if (!allowed) throw new ChatControlForbiddenError(owner.taskId)
  }
}
