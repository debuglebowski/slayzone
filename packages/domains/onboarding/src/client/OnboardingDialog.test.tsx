// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createTrpcTest } from '@slayzone/transport/testing'

/**
 * Pins when the onboarding dialog opens on its own (the stored
 * `onboarding_completed` setting resolves to anything but 'true'), that an
 * auto-opened dialog is non-dismissable (no Skip), and the step telemetry.
 */

let tracked: Array<[string, unknown]> = []
vi.mock('@slayzone/telemetry/client', () => {
  const tracker = {
    track: (event: string, props: unknown) => {
      tracked.push([event, props])
    }
  }
  return { useTelemetry: () => ({ setTier: () => {} }), useTrack: () => tracker }
})

type Kids = { children?: React.ReactNode }
vi.mock('@slayzone/ui', async () => ({
  ...(await vi.importActual<object>('../../../../shared/ui/src/use-deps-changed')),
  Dialog: ({ open, children }: { open: boolean } & Kids) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: Kids) => <div data-testid="onboarding-dialog">{children}</div>,
  Button: ({ children, variant: _v, ...props }: Record<string, unknown> & Kids) => (
    <button {...(props as React.ComponentProps<'button'>)}>{children}</button>
  ),
  IconButton: ({ children, variant: _v, ...props }: Record<string, unknown> & Kids) => (
    <button {...(props as React.ComponentProps<'button'>)}>{children}</button>
  ),
  cn: (...xs: unknown[]) => xs.filter(Boolean).join(' ')
}))

const step = (name: string) =>
  function MockStep() {
    return <div data-testid={`step-${name}`} />
  }
vi.mock('./WelcomeStep', () => ({ WelcomeStep: step('welcome') }))
vi.mock('./DisclaimerStep', () => ({ DisclaimerStep: step('disclaimer') }))
vi.mock('./ProviderStep', () => ({ ProviderStep: step('provider') }))
vi.mock('./AnalyticsStep', () => ({ AnalyticsStep: step('analytics') }))
vi.mock('./CliInstallStep', () => ({ CliInstallStep: step('cli') }))
vi.mock('./SuccessStep', () => ({ SuccessStep: step('success') }))

const { OnboardingDialog } = await import('./OnboardingDialog')

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  })
}

/** `settings.get onboarding_completed` answers once `answer` is called. */
function setup(props: { externalOpen?: boolean } = {}) {
  let answer!: (value: string | null) => void
  const stored = new Promise<string | null>((r) => {
    answer = r
  })
  const trpc = createTrpcTest({
    procedures: {
      'settings.get': () => stored,
      'settings.set': () => null
    }
  })
  const Wrapper = trpc.wrapper
  const view = render(
    <Wrapper>
      <OnboardingDialog {...props} />
    </Wrapper>
  )
  return {
    view,
    answer: async (value: string | null) => {
      await act(async () => answer(value))
      await flush()
    }
  }
}

beforeEach(() => {
  tracked = []
})
afterEach(() => cleanup())

describe('OnboardingDialog auto-open', () => {
  it('opens on its own once the setting resolves to not-completed', async () => {
    const { answer } = setup()
    await flush()
    expect(screen.queryByTestId('onboarding-dialog')).toBeNull()
    expect(tracked).toEqual([])

    await answer(null)
    expect(screen.getByTestId('step-welcome')).toBeTruthy()
    expect(screen.queryByText('Skip')).toBeNull()
    expect(tracked).toEqual([['onboarding_step', { step: 0, step_name: 'welcome' }]])
  })

  it('stays closed when onboarding is already completed', async () => {
    const { answer } = setup()
    await answer('true')
    expect(screen.queryByTestId('onboarding-dialog')).toBeNull()
    expect(tracked).toEqual([])
  })

  it('externally opened: skippable until the setting resolves to not-completed', async () => {
    const { answer } = setup({ externalOpen: true })
    await flush()
    expect(screen.getByTestId('step-welcome')).toBeTruthy()
    expect(screen.getByText('Skip')).toBeTruthy()
    expect(tracked).toEqual([['onboarding_step', { step: 0, step_name: 'welcome' }]])

    await answer('false')
    expect(screen.getByTestId('step-welcome')).toBeTruthy()
    expect(screen.queryByText('Skip')).toBeNull()
    expect(tracked).toHaveLength(1)
  })
})
