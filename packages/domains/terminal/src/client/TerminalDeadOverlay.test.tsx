// @vitest-environment jsdom
// The dead-session overlay says why the session ended. "The computer couldn't
// start the agent." alone names no cause; the computer's own refusal does
// ("posix_spawnp failed. … Fix: chmod +x …"), so the overlay shows it too.
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { TerminalDeadOverlay, type TerminalDeadOverlayProps } from './TerminalDeadOverlay'

afterEach(cleanup)

const props = (over: Partial<TerminalDeadOverlayProps> = {}): TerminalDeadOverlayProps => ({
  isStaleSession: false,
  providerLabel: 'Claude Code',
  deadCrashOutput: null,
  deadExitCode: -1,
  deadExitReason: 'spawn-failed',
  deadExitDetail: null,
  onRetry: vi.fn(),
  onStartFresh: vi.fn(),
  onRetryClick: vi.fn(),
  onDoctor: vi.fn(),
  doctorLoading: false,
  doctorResults: null,
  ...over
})

it("shows the computer's own words under the reason", () => {
  const detail =
    "posix_spawnp failed. /h/spawn-helper is not executable. Fix: chmod +x '/h/spawn-helper'"
  render(<TerminalDeadOverlay {...props({ deadExitDetail: detail })} />)
  expect(screen.getByText("The computer couldn't start the agent.")).toBeTruthy()
  expect(screen.getByText(detail)).toBeTruthy()
})

it('without a detail, shows only the reason', () => {
  const { container } = render(<TerminalDeadOverlay {...props()} />)
  expect(screen.getByText("The computer couldn't start the agent.")).toBeTruthy()
  expect(container.querySelector('[data-testid="terminal-dead-detail"]')).toBeNull()
})
