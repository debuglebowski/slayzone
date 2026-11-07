/**
 * `direct.grant` / `direct.revoke` / `direct.reset` — one hub's door into the
 * computer's direct-link grant table (./grants). One table per hub connection, so
 * the hub key is fixed by WHICH link a frame arrived on, never by its params.
 *
 * @module computer/direct/handlers
 */
import {
  directGrantParamsSchema,
  directResetParamsSchema,
  directRevokeParamsSchema,
  type DirectGrantResult,
  type DirectResetResult,
  type DirectRevokeResult,
  HubToComputerMethods
} from '@slayzone/computer-transport/shared'
import type { HubMethodTable } from '../handlers/types'
import type { DirectGrantStore } from './grants'

export function createDirectGrantHandlers(store: DirectGrantStore, hubKey: string): HubMethodTable {
  return {
    [HubToComputerMethods.directGrant]: async (raw): Promise<DirectGrantResult> => {
      store.grant(hubKey, directGrantParamsSchema.parse(raw))
      return { ok: true }
    },
    [HubToComputerMethods.directRevoke]: async (raw): Promise<DirectRevokeResult> => ({
      revoked: store.revoke(hubKey, directRevokeParamsSchema.parse(raw))
    }),
    [HubToComputerMethods.directReset]: async (raw): Promise<DirectResetResult> => ({
      dropped: store.reset(hubKey, directResetParamsSchema.parse(raw).keep)
    })
  }
}
