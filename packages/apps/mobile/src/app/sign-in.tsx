import { useHubSessions } from '../hub-sessions'
import { Screen } from '../Screen'
import { SignInScreen } from '../SignInScreen'

/**
 * `/sign-in`: the first hub, or the demo ("Try demo", no hub needed). Once signed in
 * (or in the demo), the root layout's guards move the app to its tabs; nothing here
 * navigates.
 */
export default function SignInRoute() {
  const { signedIn, enterDemo } = useHubSessions()
  return (
    <Screen>
      <SignInScreen
        title="Sign in to a hub"
        onSignedIn={signedIn}
        onTryDemo={enterDemo}
        devAutoSubmit
      />
    </Screen>
  )
}
