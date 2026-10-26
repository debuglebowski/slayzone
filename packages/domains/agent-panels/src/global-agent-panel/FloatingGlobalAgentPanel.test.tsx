// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createTrpcTest } from '@slayzone/transport/testing'

const sessionStateFor = vi.hoisted(() => vi.fn((id: string) => `state:${id}`))
vi.mock('@slayzone/terminal/client', () => ({ useSessionState: sessionStateFor }))
vi.mock('@slayzone/terminal/client/LazyTerminal', () => ({
  Terminal: (props: { sessionId: string; cwd: string; mode: string }) => (
    <div data-testid="terminal">
      {props.sessionId}|{props.cwd}|{props.mode}
    </div>
  )
}))
vi.mock('./FloatingGlobalAgentPanelCollapsed', () => ({
  FloatingGlobalAgentPanelCollapsed: (props: { state: string }) => (
    <div data-testid="collapsed-widget">{props.state}</div>
  )
}))
vi.mock('./FloatingGlobalAgentPanelCollapsedIcon', () => ({
  FloatingGlobalAgentPanelCollapsedIcon: (props: { state: string }) => (
    <div data-testid="collapsed-icon">{props.state}</div>
  )
}))

import { FloatingGlobalAgentPanel } from './FloatingGlobalAgentPanel'

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  })
}

let session: { sessionId: string; cwd: string; mode: string } | null
let config: { style: string } | null
let calls: string[]
let sessionChanged: Array<(d: unknown) => void>
let collapseChanged: Array<(d: unknown) => void>

beforeEach(() => {
  session = { sessionId: 's1', cwd: '/w', mode: 'claude-code' }
  config = { style: 'icon' }
  calls = []
  sessionChanged = []
  collapseChanged = []
  const sub =
    (list: Array<(d: unknown) => void>) => (_input: unknown, push: (d: unknown) => void) => {
      list.push(push)
      return () => {
        list.splice(list.indexOf(push), 1)
      }
    }
  const { wrapper: Wrapper } = createTrpcTest({
    procedures: {
      'app.floatingAgent.getSession': () => {
        calls.push('getSession')
        return session
      },
      'app.floatingAgent.getConfig': () => {
        calls.push('getConfig')
        return config
      },
      'app.floatingAgent.getState': () => ({ mode: null, hasCustomSize: false })
    },
    subscriptions: {
      'app.floatingAgent.onSessionChanged': sub(sessionChanged),
      'app.floatingAgent.onCollapseChanged': sub(collapseChanged),
      'app.floatingAgent.onState': () => () => undefined
    }
  })
  render(
    <Wrapper>
      <FloatingGlobalAgentPanel />
    </Wrapper>
  )
})

afterEach(() => {
  cleanup()
})

describe('FloatingGlobalAgentPanel session + config load', () => {
  it('loads the session then the config (in order) and reloads on session change', async () => {
    // Before load: widget style, no session.
    expect(screen.getByTestId('collapsed-widget').textContent).toBe('state:')
    await flush()
    expect(calls).toEqual(['getSession', 'getConfig'])
    expect(screen.getByTestId('collapsed-icon').textContent).toBe('state:s1')

    session = { sessionId: 's2', cwd: '/x', mode: 'codex' }
    config = null
    act(() => {
      for (const push of [...sessionChanged]) push(undefined)
    })
    await flush()
    expect(calls).toEqual(['getSession', 'getConfig', 'getSession', 'getConfig'])
    // null config keeps the previous style; the new session is picked up.
    expect(screen.getByTestId('collapsed-icon').textContent).toBe('state:s2')

    // Expanded → terminal for the loaded session.
    act(() => {
      for (const push of [...collapseChanged]) push({ collapsed: false })
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200))
    })
    expect(screen.getByTestId('terminal').textContent).toBe('s2|/x|codex')
  })

  it('a null session keeps the previous one', async () => {
    await flush()
    session = null
    act(() => {
      for (const push of [...sessionChanged]) push(undefined)
    })
    await flush()
    expect(screen.getByTestId('collapsed-icon').textContent).toBe('state:s1')
  })
})
