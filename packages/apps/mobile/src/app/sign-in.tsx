import { useHubSessions } from '../hub-sessions'
import { Screen } from '../Screen'
import { SignInScreen } from '../SignInScreen'

/**
 * `/sign-in`: the first hub. Once signed in, the root layout's guards move the app to
 * its tabs; nothing here navigates.
 */
export default function SignInRoute() {
  const { signedIn } = useHubSessions()
  return (
    <Screen>
      <SignInScreen title="Sign in to a hub" onSignedIn={signedIn} devAutoSubmit />
    </Screen>
  )
}
