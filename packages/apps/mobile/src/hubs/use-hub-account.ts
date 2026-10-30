/**
 * Who the app is signed in as on a hub: the account its bearer belongs to, as the hub
 * says (`fetchSessionEmail`: better-auth's get-session, the call the CLI makes at
 * `slay hub login`). Read once per bearer, in the hub's `HubScope` (its query cache
 * goes with the hub at sign-out).
 */
import { createFetchHubTransport, fetchSessionEmail } from '@slayzone/hub-auth/client'
import { hubUrlFromAddr } from '@slayzone/platform/hub-addr'
import { useQuery } from '@tanstack/react-query'
import type { HubSession } from '../hub-session'

/** React Native's `fetch` — no cookies, so no browser CSRF path (as at sign-in). */
const transport = createFetchHubTransport(fetch)

/** The account's email; null while unknown (loading, hub unreachable, no answer). */
export function useHubAccount(session: HubSession): string | null {
  const { data } = useQuery({
    // The bearer is the key: signing in again (maybe as someone else) reads it anew.
    queryKey: ['hub-account', session.token],
    queryFn: () =>
      fetchSessionEmail(transport, hubUrlFromAddr(session.entry.label, 'http'), session.token),
    staleTime: Number.POSITIVE_INFINITY
  })
  return data ?? null
}
