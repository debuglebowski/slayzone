/**
 * @vitest-environment jsdom
 *
 * The sign-in screen offers what the hub offers (T-13): "Sign in with Microsoft" on an
 * Entra hub — a link to the hub's `/api/auth/web-sso` (no form, so no CSP form-action
 * on the redirect chain) — and the password form only where password sign-in is on. No
 * password field at all where it is off.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { LoginScreen } from './LoginScreen'

afterEach(() => cleanup())

describe('LoginScreen', () => {
  it('password off (an Entra hub): Microsoft only — no password field', () => {
    render(<LoginScreen methods={{ password: false, sso: true }} />)
    const link = screen.getByTestId('web-login-sso')
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe('/api/auth/web-sso')
    expect(link.closest('form')).toBeNull()
    expect(screen.queryByTestId('web-login-password')).toBeNull()
    expect(screen.queryByTestId('web-login-email')).toBeNull()
    expect(document.querySelector('input[type="password"]')).toBeNull()
  })

  it('a password hub (login on, no Entra): the password form only, as before', () => {
    render(<LoginScreen methods={{ password: true, sso: false }} />)
    expect(screen.getByTestId('web-login-email')).toBeTruthy()
    expect(screen.getByTestId('web-login-password')).toBeTruthy()
    expect(screen.queryByTestId('web-login-sso')).toBeNull()
  })

  it('both on: both offered', () => {
    render(<LoginScreen methods={{ password: true, sso: true }} />)
    expect(screen.getByTestId('web-login-sso')).toBeTruthy()
    expect(screen.getByTestId('web-login-password')).toBeTruthy()
  })

  it('a sign-in that did not complete says why, with its code', () => {
    render(
      <LoginScreen
        methods={{ password: false, sso: true }}
        signInError={{ code: 'ACCOUNT_DISABLED', message: 'This account is disabled.' }}
      />
    )
    const shown = screen.getByTestId('web-login-sso-error').textContent ?? ''
    expect(shown).toContain('This account is disabled.')
    expect(shown).toContain('ACCOUNT_DISABLED')
  })

  it('no method known (health failed): says to reload, offers nothing', () => {
    render(<LoginScreen methods={{ password: false, sso: false }} />)
    expect(screen.getByTestId('web-login-unavailable')).toBeTruthy()
    expect(screen.queryByTestId('web-login-sso')).toBeNull()
    expect(document.querySelector('input')).toBeNull()
  })
})
