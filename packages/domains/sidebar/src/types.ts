import type { ReactNode } from 'react'

/**
 * Structural mirror of the app's `useOnboardingChecklist` return shape.
 * The hook itself stays app-side (it depends on app-local onboarding state);
 * the sidebar only needs the data shape so the app can inject it as a prop and
 * the fork can pass a default. Kept structurally identical so the app's hook
 * output assigns without an explicit import.
 */
export interface OnboardingChecklistStep {
  id: string
  label: string
  completed: boolean
  disabled?: boolean
  allowWhenCompleted?: boolean
  onClick: () => void
}

export interface OnboardingChecklistState {
  steps: OnboardingChecklistStep[]
  dismissed: boolean
  remainingCount: number
  hasRemaining: boolean
  onDismiss: () => void
}

/** Props of the app's renderless `KeyRecorder` (injected via the `keyRecorder` prop). */
export interface KeyRecorderProps {
  active: boolean
  onCapture: (keys: string) => void
  onCancel: () => void
}

/** Renderless component that records a hotkey while `active`. */
export type KeyRecorderComponent = (props: KeyRecorderProps) => ReactNode

/**
 * What the sidebar's startup card shows while a restored workspace comes up: agents
 * started so far (and how many are still booting or waiting for a start slot), and
 * tabs loaded. `settled`: nothing left in flight — the card says "Ready" until it goes.
 */
export interface StartupProgress {
  settled: boolean
  agentsReady: number
  agentsTotal: number
  agentsBooting: number
  agentsQueued: number
  tabsLoaded: number
  tabsTotal: number
}
