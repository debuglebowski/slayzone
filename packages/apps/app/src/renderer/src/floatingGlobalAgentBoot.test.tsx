// @vitest-environment jsdom
// The floating global agent window boots on its own (main.tsx): server url, window
// id, then the hub registry. A failure anywhere there used to leave the window empty
// for good (the rejection went nowhere). It must say so and offer a retry.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, screen } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import type { ReactNode } from 'react'

const initTrpcClient = vi.hoisted(() => vi.fn())
vi.mock('./trpc', () => ({ initTrpcClient }))
const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>
vi.mock('@slayzone/terminal', () => ({ PtyProvider: Pass }))
vi.mock('@slayzone/settings', () => ({ ThemeProvider: Pass }))
vi.mock('@slayzone/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@slayzone/ui')>()),
  TooltipProvider: Pass
}))
vi.mock('@slayzone/transport/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@slayzone/transport/client')>()),
  FederatedRoot: Pass,
  HubScope: ({ hubId, children }: { hubId: string; children: ReactNode }) => (
    <div data-testid={`hub-${hubId}`}>{children}</div>
  )
}))
vi.mock('@slayzone/agent-panels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@slayzone/agent-panels')>()),
  FloatingGlobalAgentPanel: () => <div data-testid="floating-agent" />
}))

const { bootFloatingGlobalAgentPanel } = await import('./floatingGlobalAgentBoot')

let container: HTMLElement
let root: Root
const onError = vi.fn()
const bootstrap = {
  getServerUrl: vi.fn(async () => ({ url: 'ws://127.0.0.1:1/trpc' })),
  getWindowId: vi.fn(async () => 7),
  getHubRegistry: vi.fn(async () => ({
    hubs: [{ id: 'local', kind: 'local' as const, label: 'This computer' }],
    defaultHubId: 'local'
  })),
  getHubTokens: vi.fn(async () => ({})),
  floatingAgentBootFailed: vi.fn(async () => {})
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  cleanup()
  vi.clearAllMocks()
})

const boot = () =>
  act(() =>
    bootFloatingGlobalAgentPanel(root, {
      bootstrap,
      withWindowId: (url, id) => `${url}?windowId=${id}`,
      onError
    })
  )

describe('bootFloatingGlobalAgentPanel', () => {
  it("renders the panel on this window's default hub", async () => {
    await boot()
    expect(initTrpcClient).toHaveBeenCalledWith('ws://127.0.0.1:1/trpc?windowId=7', {
      links: [expect.any(Function)]
    })
    expect(screen.getByTestId('hub-local').contains(screen.getByTestId('floating-agent'))).toBe(
      true
    )
    expect(onError).not.toHaveBeenCalled()
    expect(bootstrap.floatingAgentBootFailed).not.toHaveBeenCalled()
  })

  it("the hub list can't be loaded: says so with a retry, and reports why", async () => {
    const failure = new Error('registry unavailable')
    bootstrap.getHubRegistry.mockRejectedValueOnce(failure)
    await boot()
    expect(screen.getByTestId('global-agent-hub-unavailable')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(screen.queryByTestId('floating-agent')).toBeNull()
    expect(onError).toHaveBeenCalledWith(failure)
    // A collapsed widget (220×80) can't fit the message: the host expands it.
    expect(bootstrap.floatingAgentBootFailed).toHaveBeenCalledOnce()
  })

  it('the host failing to expand the window still leaves the message', async () => {
    bootstrap.getHubRegistry.mockRejectedValueOnce(new Error('registry unavailable'))
    bootstrap.floatingAgentBootFailed.mockRejectedValueOnce(new Error('no ipc'))
    await boot()
    expect(screen.getByTestId('global-agent-hub-unavailable')).toBeTruthy()
  })

  it("the server url can't be read: the same", async () => {
    bootstrap.getServerUrl.mockRejectedValueOnce(new Error('no server'))
    await boot()
    expect(screen.getByTestId('global-agent-hub-unavailable')).toBeTruthy()
  })
})
