import { getTrpcClient } from '@slayzone/transport/client'
import type { HibernatedSessionIdsSource } from '@slayzone/terminal'

/**
 * task-terminals' half of terminal's hibernated-session contract: the persisted
 * set of sessions idle-close hibernated (`taskTerminals.listHibernatedSessions`).
 * The app entry passes it to `registerHibernatedSessionIdsSource` once, before its
 * first render. Own subpath so registering it does not pull the client barrel.
 */
export const hibernatedSessionIdsSource: HibernatedSessionIdsSource = () =>
  getTrpcClient().taskTerminals.listHibernatedSessions.query()
