import { useState } from 'react'
import { electronBootstrap } from '@slayzone/transport/client'
import type { SignInError } from './sign-in-error'

/** Where "Sign in with Microsoft" goes (hub-auth `web-sign-in.ts`). */
const SSO_SIGN_IN_PATH = '/api/auth/web-sso'

export interface LoginScreenProps {
  /** What the hub offers a browser (`/health`'s switches, hub-health.ts). */
  methods: { password: boolean; sso: boolean }
  /** Why the last sign-in did not complete (`?signin=failed` / `?error=`), if it did not. */
  signInError?: SignInError | null
}

/**
 * Web shell sign-in screen. Rendered by `main.tsx` when a hub that requires login
 * reports no live web session for this browser — the first screen a browser sees
 * there, not an edge case.
 *
 * WHAT IT OFFERS (T-13), from the hub's switches: "Sign in with Microsoft" on a hub
 * with Entra sign-in — a plain link to the hub's `/api/auth/web-sso`, which redirects
 * through Entra and back. A link, not a form: CSP `form-action` governs every redirect
 * after a form submission, and Entra may hop to hosts of its own (a federated sign-in)
 * that no allowlist here can know; no directive governs a link's navigation. The
 * password form only where password sign-in is on — no password field at all where it
 * is off.
 *
 * Self-contained inline styling, mirroring `RemoteConfigScreen.tsx`'s
 * pattern: this renders before ThemeProvider (or any tRPC connection) exists,
 * so theme token classes would not resolve and no data is available yet.
 *
 * After a password sign-in the hub has set the session cookie; a full reload is the
 * simplest way back into `main.tsx`'s boot sequence, which will now find the session
 * and mount the real app — same recovery-via-reload pattern `RemoteConfigScreen` uses
 * after `setBootSettings`. A Microsoft sign-in comes back to `/` by redirect.
 */
export function LoginScreen({ methods, signInError = null }: LoginScreenProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [status, setStatus] = useState<
    { kind: 'idle' } | { kind: 'submitting' } | { kind: 'error'; message: string }
  >({ kind: 'idle' })

  const submit = async (): Promise<void> => {
    if (!email.trim() || !password) return
    setStatus({ kind: 'submitting' })
    const result = await electronBootstrap.hubLogin({
      hubId: 'local',
      url: '',
      email: email.trim(),
      password
    })
    if (!result.ok) {
      setStatus({ kind: 'error', message: result.error })
      return
    }
    window.location.reload()
  }

  const submitting = status.kind === 'submitting'
  const cannotSubmit = submitting || !email.trim() || !password

  return (
    <div
      data-testid="web-login-screen"
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0a0a0a',
        color: '#e8e8e8',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      }}
    >
      <div style={cardStyle}>
        <h1 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>Sign in to SlayZone</h1>
        <p style={{ fontSize: 13, color: '#999', marginBottom: 20, lineHeight: 1.5 }}>
          Sign in with your hub account to view tasks and drive your agents from this browser.
        </p>

        {methods.sso && (
          <a href={SSO_SIGN_IN_PATH} data-testid="web-login-sso" style={linkButtonStyle}>
            Sign in with Microsoft
          </a>
        )}

        {signInError !== null && (
          <p data-testid="web-login-sso-error" role="alert" style={errorStyle}>
            {signInError.message}
            <span style={{ display: 'block', color: '#777', marginTop: 4 }}>
              Code: {signInError.code}
            </span>
          </p>
        )}

        {methods.sso && methods.password && (
          <p style={{ fontSize: 12, color: '#777', textAlign: 'center', margin: '16px 0 0' }}>or</p>
        )}

        {methods.password && (
          <form
            data-testid="web-login-password-form"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <label style={{ display: 'block', fontSize: 12, color: '#bbb', marginBottom: 6 }}>
              Email
            </label>
            <input
              type="email"
              data-testid="web-login-email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus={!methods.sso}
              autoComplete="username"
              style={inputStyle}
            />

            <label style={{ display: 'block', fontSize: 12, color: '#bbb', margin: '12px 0 6px' }}>
              Password
            </label>
            <input
              type="password"
              data-testid="web-login-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              style={inputStyle}
            />

            {status.kind === 'error' && (
              <p data-testid="web-login-error" style={errorStyle}>
                {status.message}
              </p>
            )}

            <button
              type="submit"
              data-testid="web-login-submit"
              disabled={cannotSubmit}
              style={buttonStyle(cannotSubmit, submitting)}
            >
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}

        {!methods.sso && !methods.password && (
          <p data-testid="web-login-unavailable" style={errorStyle}>
            Could not load this hub's sign-in options. Reload the page to try again.
          </p>
        )}
      </div>
    </div>
  )
}

const cardStyle: React.CSSProperties = {
  width: 360,
  padding: 32,
  background: '#141414',
  borderRadius: 12,
  border: '1px solid #2a2a2a'
}

const buttonStyle = (disabled: boolean, busy = false): React.CSSProperties => ({
  width: '100%',
  marginTop: 20,
  padding: '10px 14px',
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 6,
  border: '1px solid #333',
  background: busy ? '#2a4a70' : '#3a6ea5',
  color: '#fff',
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.6 : 1
})

const linkButtonStyle: React.CSSProperties = {
  ...buttonStyle(false),
  display: 'block',
  boxSizing: 'border-box',
  textAlign: 'center',
  textDecoration: 'none'
}

const errorStyle: React.CSSProperties = { fontSize: 12, color: '#e57373', marginTop: 12 }

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  fontSize: 13,
  background: '#0a0a0a',
  color: '#e8e8e8',
  border: '1px solid #333',
  borderRadius: 6,
  outline: 'none',
  boxSizing: 'border-box'
}
