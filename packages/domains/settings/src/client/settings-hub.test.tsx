// @vitest-environment jsdom
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

/**
 * Pins the Settings dialog's hub picker: which hub the hub-wide sections talk to.
 * Hub-wide sections follow the picked hub; everything else stays on the default hub.
 */

type Kids = { children?: React.ReactNode }
type Hub = { id: string; kind: string; label: string; url?: string }

let federation: { hubs: Hub[]; defaultHubId: string } | null = null

vi.mock('@slayzone/transport/client', () => ({
  useFederationOrNull: () => federation,
  HubScope: ({ hubId, children }: { hubId: string } & Kids) => (
    <div data-hub-scope={hubId}>{children}</div>
  )
}))

vi.mock('@slayzone/ui', () => ({
  Select: ({
    value,
    onValueChange,
    children
  }: { value?: string; onValueChange?: (v: string) => void } & Kids) => (
    <select aria-label="Hub" value={value} onChange={(e) => onValueChange?.(e.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: Kids) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string } & Kids) => (
    <option value={value}>{children}</option>
  )
}))

const { SettingsHubProvider, SettingsHubPicker, HubWideSection } = await import('./settings-hub')

const LOCAL: Hub = {
  id: 'local',
  kind: 'local',
  label: 'This computer',
  url: 'ws://127.0.0.1:1/trpc'
}
const REMOTE: Hub = {
  id: 'hub:ws://r',
  kind: 'remote',
  label: 'Team hub',
  url: 'ws://r/trpc'
}

function ui() {
  return (
    <SettingsHubProvider>
      <SettingsHubPicker />
      <HubWideSection>
        <span data-testid="hub-wide">hub-wide</span>
      </HubWideSection>
      <span data-testid="personal">personal</span>
    </SettingsHubProvider>
  )
}

const scopeOf = (testId: string) =>
  screen.getByTestId(testId).closest('[data-hub-scope]')?.getAttribute('data-hub-scope') ?? null

afterEach(() => {
  cleanup()
  federation = null
})

describe('settings hub picker', () => {
  it('renders hub-wide sections unscoped outside a provider', () => {
    render(
      <HubWideSection>
        <span data-testid="hub-wide">x</span>
      </HubWideSection>
    )
    expect(scopeOf('hub-wide')).toBeNull()
  })

  it('hides the picker and does not scope with a single hub', () => {
    federation = { hubs: [LOCAL], defaultHubId: 'local' }
    render(ui())
    expect(screen.queryByLabelText('Hub')).toBeNull()
    expect(scopeOf('hub-wide')).toBeNull()
  })

  it('ignores hubs without an address', () => {
    federation = {
      hubs: [LOCAL, { ...REMOTE, url: undefined }],
      defaultHubId: 'local'
    }
    render(ui())
    expect(screen.queryByLabelText('Hub')).toBeNull()
  })

  it('starts on the default hub, unscoped', () => {
    federation = { hubs: [LOCAL, REMOTE], defaultHubId: 'local' }
    render(ui())
    const picker = screen.getByLabelText('Hub') as HTMLSelectElement
    expect(picker.value).toBe('local')
    expect(scopeOf('hub-wide')).toBeNull()
  })

  it('scopes only hub-wide sections to a picked remote hub', () => {
    federation = { hubs: [LOCAL, REMOTE], defaultHubId: 'local' }
    render(ui())
    fireEvent.change(screen.getByLabelText('Hub'), {
      target: { value: REMOTE.id }
    })
    expect(scopeOf('hub-wide')).toBe(REMOTE.id)
    expect(scopeOf('personal')).toBeNull()
    expect(screen.getByTestId('hub-wide-note').textContent).toContain('Team hub')

    fireEvent.change(screen.getByLabelText('Hub'), {
      target: { value: 'local' }
    })
    expect(scopeOf('hub-wide')).toBeNull()
  })

  it('falls back to the default hub when the picked hub leaves the federation', () => {
    federation = { hubs: [LOCAL, REMOTE], defaultHubId: 'local' }
    const { rerender } = render(ui())
    fireEvent.change(screen.getByLabelText('Hub'), {
      target: { value: REMOTE.id }
    })
    federation = { hubs: [LOCAL], defaultHubId: 'local' }
    rerender(ui())
    expect(scopeOf('hub-wide')).toBeNull()
  })
})
