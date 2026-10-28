// @vitest-environment jsdom
/**
 * The integration credential modal keeps local edits while open and re-seeds on a
 * re-open or a provider switch (form state that re-seeds from props).
 */
import React, { createContext, useContext } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'

vi.mock('./trpc', () => {
  const inert = { mutationOptions: () => ({}) }
  return {
    useTRPC: () => new Proxy({}, { get: () => new Proxy({}, { get: () => new Proxy(inert, {}) }) })
  }
})

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutateAsync: vi.fn() })
}))

type Kids = { children?: React.ReactNode }

vi.mock('@slayzone/ui', () => {
  const Passthrough = ({ children }: Kids) => <>{children}</>
  const OpenCtx = createContext(false)
  const Dialog = ({ open = false, children }: Kids & { open?: boolean }) => (
    <OpenCtx.Provider value={open}>{children}</OpenCtx.Provider>
  )
  const DialogContent = ({ children }: Kids) => (useContext(OpenCtx) ? <>{children}</> : null)
  const Button = ({ children, ...props }: React.ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  )
  return {
    Button,
    Dialog,
    DialogContent,
    DialogHeader: Passthrough,
    DialogTitle: Passthrough,
    Input: (props: React.ComponentProps<'input'>) => <input {...props} />
  }
})

import { ProjectIntegrationConnectionModal } from './ProjectIntegrationConnectionModal'

const valueOf = (selector: string) =>
  (document.querySelector(selector) as HTMLInputElement | null)?.value
const type = (selector: string, value: string) =>
  fireEvent.change(document.querySelector(selector)!, { target: { value } })

afterEach(cleanup)

describe('ProjectIntegrationConnectionModal', () => {
  const ui = (open: boolean, provider: 'github' | 'linear' = 'github') => (
    <ProjectIntegrationConnectionModal
      open={open}
      onOpenChange={vi.fn()}
      projectId="proj-1"
      provider={provider}
      mode="connect"
      onConnectionsChanged={vi.fn()}
    />
  )

  it('keeps the credential while open, clears it on re-open and on provider switch', () => {
    const { rerender } = render(ui(true))
    type('#project-github-connect-credential', 'ghp_secret')
    rerender(ui(true))
    expect(valueOf('#project-github-connect-credential')).toBe('ghp_secret')

    rerender(ui(false))
    rerender(ui(true))
    expect(valueOf('#project-github-connect-credential')).toBe('')

    type('#project-github-connect-credential', 'ghp_secret')
    rerender(ui(true, 'linear'))
    expect(valueOf('#project-linear-connect-credential')).toBe('')
  })

  it('re-rendering with unchanged props keeps the credential (reset only on transitions)', () => {
    const { rerender } = render(ui(true))
    type('#project-github-connect-credential', 'kept')
    rerender(ui(true, 'github'))
    expect(valueOf('#project-github-connect-credential')).toBe('kept')
  })
})
