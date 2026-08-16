import { useState } from 'react'
import { electronBootstrap } from '@slayzone/transport/client'

/**
 * Web shell sign-in screen. Rendered by `main.tsx` whenever no scoped
 * session token is stored — every hub the web shell can reach enforces auth
 * unconditionally (`hubAuthRequired = !supervised`), so this is the first
 * screen a browser sees, not an edge case.
 *
 * Self-contained inline styling, mirroring `RemoteConfigScreen.tsx`'s
 * pattern: this renders before ThemeProvider (or any tRPC connection) exists,
 * so theme token classes would not resolve and no data is available yet.
 *
 * On success, `electronBootstrap.hubLogin` has already written the scoped
 * token to storage (see window-api.ts); a full reload is the simplest way
 * back into `main.tsx`'s boot sequence, which will now find a token and mount
 * the real app — same recovery-via-reload pattern `RemoteConfigScreen` uses
 * after `setBootSettings`.
 */
export function LoginScreen() {
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
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        style={{
          width: 360,
          padding: 32,
          background: '#141414',
          borderRadius: 12,
          border: '1px solid #2a2a2a'
        }}
      >
        <h1 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>Sign in to SlayZone</h1>
        <p style={{ fontSize: 13, color: '#999', marginBottom: 20, lineHeight: 1.5 }}>
          Sign in with your hub account to view tasks and drive your agents from this browser.
        </p>

        <label style={{ display: 'block', fontSize: 12, color: '#bbb', marginBottom: 6 }}>
          Email
        </label>
        <input
          type="email"
          data-testid="web-login-email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
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
          <p
            data-testid="web-login-error"
            style={{ fontSize: 12, color: '#e57373', marginTop: 12 }}
          >
            {status.message}
          </p>
        )}

        <button
          type="submit"
          data-testid="web-login-submit"
          disabled={submitting || !email.trim() || !password}
          style={{
            width: '100%',
            marginTop: 20,
            padding: '10px 14px',
            fontSize: 13,
            fontWeight: 600,
            borderRadius: 6,
            border: '1px solid #333',
            background: submitting ? '#2a4a70' : '#3a6ea5',
            color: '#fff',
            cursor: submitting || !email.trim() || !password ? 'not-allowed' : 'pointer',
            opacity: submitting || !email.trim() || !password ? 0.6 : 1
          }}
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}

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
