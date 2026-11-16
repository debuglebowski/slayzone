/**
 * `agentSessions.current` (S8): the main tab's current conversation as the task's
 * computer answers it. "None" (null) and "cannot be asked" (its computer offline)
 * are different answers: the task page shows the "detect the session" / "resume
 * won't work" banners only for "none", and records a detected id only against a
 * known current one. Offline is a PRECONDITION_FAILED, like the sessions list.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { agentSessionsRouter } from './agent-sessions-router'
import { setTaskSessionLedger, type SessionLedgerClient } from './ops'

let online = true
let current: string | null = null
setTaskSessionLedger({
  forTask: async () => (online ? 'pc' : null),
  store: { getCurrentConversationId: async () => current }
} as unknown as SessionLedgerClient)

const caller = agentSessionsRouter.createCaller({ db: {}, dataRoot: '' } as never)

afterEach(() => {
  online = true
  current = null
})

describe('agentSessions.current', () => {
  it('its computer answers: the current id, or null for none', async () => {
    current = 'conv-1'
    expect(await caller.current({ taskId: 't', agentId: 'codex' })).toBe('conv-1')
    current = null
    expect(await caller.current({ taskId: 't', agentId: 'codex' })).toBeNull()
  })

  it('its computer offline: PRECONDITION_FAILED, never "no session"', async () => {
    online = false
    await expect(caller.current({ taskId: 't', agentId: 'codex' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED'
    })
  })
})
