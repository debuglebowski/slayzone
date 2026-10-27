// @vitest-environment jsdom
// Pins the settings reopen-after-reload contract App relied on when it consumed the
// request in a mount effect (#161) — open once on the requested tab, also under
// StrictMode, never again on a remount — now that useSettingsReopenTab seeds the
// open state instead. Each scenario below passed against that effect version first.
import { StrictMode, Suspense, use, useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { requestSettingsReopen } from './settings-reopen'
import { useSettingsReopenTab } from './useSettingsReopenTab'

const KEY = 'slayzone:settings-reopen-tab'

type Settled = { open: boolean; tab: string }

/** App's wiring: the hook seeds the Settings open state and initial tab. */
function Host({ onCommit }: { onCommit: (s: Settled) => void }): null {
  const reopenTab = useSettingsReopenTab()
  const [open] = useState(reopenTab !== null)
  const [tab] = useState(reopenTab ?? 'appearance')
  useEffect(() => {
    onCommit({ open, tab })
  })
  return null
}

function mount({ strict = false } = {}): { commits: Settled[]; unmount: () => void } {
  const commits: Settled[] = []
  const el = <Host onCommit={(s) => commits.push(s)} />
  const { unmount } = render(strict ? <StrictMode>{el}</StrictMode> : el)
  return { commits, unmount }
}

beforeEach(() => sessionStorage.clear())
afterEach(cleanup)

describe('settings reopen after reload', () => {
  it('opens Settings on the requested tab and drops the request', () => {
    requestSettingsReopen('connections')
    const { commits } = mount()
    expect(commits.at(-1)).toEqual({ open: true, tab: 'connections' })
    expect(sessionStorage.getItem(KEY)).toBeNull()
  })

  it('stays closed when nothing was requested', () => {
    const { commits } = mount()
    expect(commits.at(-1)).toEqual({ open: false, tab: 'appearance' })
  })

  it('StrictMode (double render + effect replay) still opens it once', () => {
    requestSettingsReopen('connections')
    const { commits } = mount({ strict: true })
    expect(commits.at(-1)).toEqual({ open: true, tab: 'connections' })
    expect(sessionStorage.getItem(KEY)).toBeNull()
  })

  it('a remount after the first mount does not reopen it', () => {
    requestSettingsReopen('connections')
    const first = mount()
    expect(first.commits.at(-1)).toEqual({ open: true, tab: 'connections' })
    first.unmount()
    const second = mount()
    expect(second.commits.at(-1)).toEqual({ open: false, tab: 'appearance' })
  })

  it('a request made while mounted is picked up by the next mount', () => {
    const first = mount()
    requestSettingsReopen('connections')
    first.unmount()
    const second = mount()
    expect(second.commits.at(-1)).toEqual({ open: true, tab: 'connections' })
    expect(sessionStorage.getItem(KEY)).toBeNull()
  })

  // The one difference from the effect version, which committed closed first and
  // opened in a second commit.
  it('opens in the first commit', () => {
    requestSettingsReopen('connections')
    const { commits } = mount()
    expect(commits).toEqual([{ open: true, tab: 'connections' }])
  })

  it('a render thrown away before commit does not lose the request', async () => {
    requestSettingsReopen('connections')
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let suspended = true
    void gate.then(() => {
      suspended = false
    })
    function SuspendOnce(): null {
      if (suspended) use(gate)
      return null
    }
    const commits: Settled[] = []
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <Host onCommit={(s) => commits.push(s)} />
          <SuspendOnce />
        </Suspense>
      )
    })
    // Host rendered (and read the request), but its sibling suspended, so those
    // renders were thrown away without committing.
    expect(commits).toEqual([])
    expect(sessionStorage.getItem(KEY)).toBe('connections')
    await act(async () => {
      release()
      await gate
    })
    expect(commits).toEqual([{ open: true, tab: 'connections' }])
    expect(sessionStorage.getItem(KEY)).toBeNull()
  })
})
