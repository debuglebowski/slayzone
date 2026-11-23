// @vitest-environment jsdom
// The global agent runs on the hub that owns its project. When this window cannot
// reach that hub (the registry does not list it, or lists it without an address),
// the panel says so and offers a retry instead of rendering nothing.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const federation = vi.hoisted(() => ({
  current: null as null | { hubs: { id: string; label: string }[] }
}))
vi.mock('@slayzone/transport/client', () => ({
  useFederationOrNull: () => federation.current
}))

import { GlobalAgentHubUnavailable } from './GlobalAgentHubUnavailable'

afterEach(() => {
  cleanup()
  federation.current = null
})

describe('GlobalAgentHubUnavailable', () => {
  it('names the hub when this window knows it', () => {
    federation.current = { hubs: [{ id: 'hub:wss://work', label: 'Work hub' }] }
    render(<GlobalAgentHubUnavailable hubId="hub:wss://work" onRetry={() => {}} />)
    expect(screen.getByTestId('global-agent-hub-unavailable').textContent).toContain(
      "Can't reach Work hub"
    )
  })

  it("falls back to the project's hub when it does not", () => {
    render(<GlobalAgentHubUnavailable hubId="hub:wss://gone" onRetry={() => {}} />)
    expect(screen.getByTestId('global-agent-hub-unavailable').textContent).toContain(
      "Can't reach this project's hub"
    )
  })

  it('retries on request', () => {
    const onRetry = vi.fn()
    render(<GlobalAgentHubUnavailable onRetry={onRetry} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('keeps the side panel its width', () => {
    render(<GlobalAgentHubUnavailable width={420} onRetry={() => {}} />)
    expect(screen.getByTestId('global-agent-hub-unavailable').style.width).toBe('420px')
  })
})
