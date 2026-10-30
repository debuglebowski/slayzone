import { Redirect } from 'expo-router'
import { HOME } from '../../routes'

/**
 * `/auth/callback`: the redirect "Sign in with Microsoft" ends on
 * (`slayzone://auth/callback`). Inside a sign-in, iOS's auth session takes that URL
 * itself (`auth/microsoft-sign-in.ts`), so the app only lands here from a link opened
 * outside one — and uses nothing in it: a code is only ever exchanged with the verifier
 * and state of a sign-in this app started. Home (the guards send a signed-out app to
 * sign-in).
 */
export default function AuthCallbackRoute() {
  return <Redirect href={HOME} />
}
