import { useRouter } from 'expo-router'
import { useCallback } from 'react'
import type { HubSession } from '../../../hub-session'
import { useHubSessions } from '../../../hub-sessions'
import { SETTINGS } from '../../../routes'
import { SignInScreen } from '../../../SignInScreen'

/**
 * `/add-hub` (in the Settings tab): sign in to another hub; its tasks join the list. A hub
 * signed in to already is named as such (signing in again replaces its sign-in).
 */
export default function AddHubRoute() {
  const { sessions = [], signedIn } = useHubSessions()
  const router = useRouter()
  const back = useCallback(
    () => (router.canGoBack() ? router.back() : router.replace(SETTINGS)),
    [router]
  )
  const onSignedIn = useCallback(
    (session: HubSession) => {
      signedIn(session)
      back()
    },
    [signedIn, back]
  )
  return (
    <SignInScreen
      title="Sign in to another hub"
      onSignedIn={onSignedIn}
      onCancel={back}
      signedInAddresses={sessions.filter((s) => !s.inProcess).map((s) => s.entry.label)}
    />
  )
}
