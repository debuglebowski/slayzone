// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

/**
 * Pins which tutorial scene the modal shows on each open: navigation inside one
 * session, and that every (re)open starts the tour from the first scene without
 * committing the previous session's scene first.
 */

/** Scene mounts, in order — a mounted scene runs its own animation timers. */
let mounted: string[] = []
const scene = (name: string) =>
  function MockScene() {
    React.useEffect(() => {
      mounted.push(name)
    }, [])
    return <div data-testid={`scene-${name}`} />
  }

vi.mock('./scenes/SceneProjects', () => ({ SceneProjects: scene('projects') }))
vi.mock('./scenes/SceneOpenTask', () => ({ SceneOpenTask: scene('open-task') }))
vi.mock('./scenes/SceneTerminal', () => ({ SceneTerminal: scene('terminal') }))
vi.mock('./scenes/SceneEditor', () => ({ SceneEditor: scene('editor') }))
vi.mock('./scenes/SceneBrowser', () => ({ SceneBrowser: scene('browser') }))
vi.mock('./scenes/SceneGit', () => ({ SceneGit: scene('git') }))
vi.mock('./scenes/SceneProcesses', () => ({ SceneProcesses: scene('processes') }))
vi.mock('./scenes/SceneCustomPanels', () => ({ SceneCustomPanels: scene('custom-panels') }))

type Kids = { children?: React.ReactNode }
vi.mock('@slayzone/ui', async () => ({
  ...(await vi.importActual<object>('../../../../../shared/ui/src/use-deps-changed')),
  Dialog: ({ open, children }: { open: boolean } & Kids) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: Kids) => <div>{children}</div>,
  Button: ({ children, variant: _v, ...props }: Record<string, unknown> & Kids) => (
    <button {...(props as React.ComponentProps<'button'>)}>{children}</button>
  ),
  cn: (...xs: unknown[]) => xs.filter(Boolean).join(' '),
  useVisibleInterval: () => {}
}))

const { TutorialAnimationModal } = await import('./TutorialAnimationModal')

/** Lets motion finish its short (≤0.18s) caption/scene enter+exit transitions. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 400))
  })
}

beforeEach(() => {
  mounted = []
})
afterEach(() => cleanup())

describe('TutorialAnimationModal', () => {
  it('navigates within a session; every reopen starts from the first scene only', async () => {
    const onClose = vi.fn()
    const { rerender } = render(<TutorialAnimationModal open onClose={onClose} />)
    await settle()
    expect(screen.getByText('Work across multiple projects')).toBeTruthy()
    expect(mounted).toEqual(['projects'])

    fireEvent.click(screen.getByText('Git'))
    await settle()
    expect(screen.getByText('Git & worktrees')).toBeTruthy()
    expect(mounted.at(-1)).toBe('git')

    rerender(<TutorialAnimationModal open={false} onClose={onClose} />)
    expect(screen.queryByText('Git & worktrees')).toBeNull()

    mounted = []
    rerender(<TutorialAnimationModal open onClose={onClose} />)
    // The first caption is up at once — not queued behind the last session's
    // caption exiting (its AnimatePresence is mode="wait").
    expect(screen.getByText('Work across multiple projects')).toBeTruthy()
    expect(screen.queryByText('Git & worktrees')).toBeNull()
    await settle()
    expect(screen.getByText('Work across multiple projects')).toBeTruthy()
    expect(screen.queryByText('Git & worktrees')).toBeNull()
    // The last session's scene never mounts (nor animates out) on reopen.
    expect(mounted).toEqual(['projects'])
  })
})
