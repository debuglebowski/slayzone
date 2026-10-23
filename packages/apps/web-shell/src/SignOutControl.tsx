import { useState } from 'react'
import { signOut } from './web-session'

/**
 * The web shell's sign-out (T-13). `main.tsx` mounts it beside the app, in its own
 * root, on a hub that requires login — the shared renderer tree (also the desktop
 * app's) is left as it is.
 *
 * The hub revokes the session, clears its cookie and audits it
 * (`web-session-routes.ts`); then a full reload back to `/` lands on the sign-in
 * screen, discarding every open subscription with it — the same reasoning
 * `authInvalidationLink` reloads for. It does not sign out of Microsoft: Entra's
 * session is single sign-on for every app the person uses, not the hub's to end.
 *
 * Inline styling for the same reason as `LoginScreen`: it sits outside the app's
 * theme provider.
 */
export function SignOutControl() {
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle')

  const run = async (): Promise<void> => {
    setState('busy')
    if (await signOut()) {
      window.location.replace('/')
      return
    }
    setState('failed')
  }

  return (
    <button
      type="button"
      data-testid="web-sign-out"
      disabled={state === 'busy'}
      onClick={() => void run()}
      title="Sign out of this hub in this browser"
      style={{
        position: 'fixed',
        right: 8,
        bottom: 8,
        zIndex: 2147483647,
        padding: '3px 8px',
        fontSize: 11,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        borderRadius: 4,
        border: '1px solid #333',
        background: '#141414',
        color: state === 'failed' ? '#e57373' : '#bbb',
        opacity: state === 'busy' ? 0.6 : 0.85,
        cursor: state === 'busy' ? 'progress' : 'pointer'
      }}
    >
      {state === 'busy'
        ? 'Signing out…'
        : state === 'failed'
          ? 'Sign-out failed — retry'
          : 'Sign out'}
    </button>
  )
}
