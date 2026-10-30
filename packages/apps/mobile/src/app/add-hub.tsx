import { useRouter } from 'expo-router'
import { useCallback } from 'react'
import type { HubSession } from '../hub-session'
import { useHubSessions } from '../hub-sessions'
import { HOME } from '../routes'
import { SignInScreen } from '../SignInScreen'

/** `/add-hub`: sign in to another hub; its tasks join the list. */
export default function AddHubRoute() {
  const { signedIn } = useHubSessions()
  const router = useRouter()
  const back = useCallback(
    () => (router.canGoBack() ? router.back() : router.replace(HOME)),
    [router]
  )
  const onSignedIn = useCallback(
    (session: HubSession) => {
      signedIn(session)
      back()
    },
    [signedIn, back]
  )
  return <SignInScreen title="Sign in to another hub" onSignedIn={onSignedIn} onCancel={back} />
}
