// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { createTrpcTest } from '@slayzone/transport/testing'
import type {
  Automation,
  CreateAutomationInput,
  UpdateAutomationInput
} from '@slayzone/automations/shared'
import { AutomationDialog } from './AutomationDialog'

function automation(id: string, overrides: Partial<Automation> = {}): Automation {
  return {
    id,
    project_id: 'p1',
    name: `auto ${id}`,
    description: `desc ${id}`,
    enabled: true,
    trigger_config: { type: 'manual', params: {} },
    conditions: [],
    actions: [{ type: 'run_command', params: { command: `echo ${id}` } }],
    run_count: 0,
    last_run_at: null,
    catchup_on_start: false,
    sort_order: 0,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ...overrides
  }
}

let wrapper: (props: { children: ReactNode }) => ReactNode
let onSave: Mock<(data: CreateAutomationInput | UpdateAutomationInput) => void>
let setHost: (next: { open: boolean; automation: Automation | null }) => void

function Host({ initial }: { initial: { open: boolean; automation: Automation | null } }) {
  const [state, setState] = useState(initial)
  const [, force] = useState(0)
  setHost = (next) => {
    setState(next)
    force((n) => n + 1)
  }
  return (
    <AutomationDialog
      open={state.open}
      onOpenChange={(open) => setState((s) => ({ ...s, open }))}
      automation={state.automation}
      projectId="p1"
      tags={[]}
      onSave={onSave}
    />
  )
}

function renderHost(initial: { open: boolean; automation: Automation | null }) {
  const Wrapper = wrapper
  return render(
    <Wrapper>
      <Host initial={initial} />
    </Wrapper>
  )
}

const nameInput = () =>
  screen.getByPlaceholderText('e.g. Auto-cleanup worktrees') as HTMLInputElement
const descInput = () =>
  screen.getByPlaceholderText('What does this automation do?') as HTMLInputElement

beforeEach(() => {
  onSave = vi.fn()
  wrapper = createTrpcTest({ procedures: { 'pty.modesList': () => [] } }).wrapper
})

afterEach(() => {
  cleanup()
})

describe('AutomationDialog form seeding', () => {
  it('seeds from the automation at mount and saves the seeded values', () => {
    const a = automation('a', { catchup_on_start: true })
    renderHost({ open: true, automation: a })
    expect(nameInput().value).toBe('auto a')
    expect(descInput().value).toBe('desc a')

    act(() => {
      fireEvent.click(screen.getByText('Save'))
    })
    expect(onSave).toHaveBeenCalledWith({
      id: 'a',
      name: 'auto a',
      description: 'desc a',
      trigger_config: { type: 'manual', params: {} },
      conditions: [],
      actions: [{ type: 'run_command', params: { command: 'echo a' } }],
      catchup_on_start: true
    })
  })

  it('reopening resets unsaved edits; switching automation re-seeds', () => {
    const a = automation('a')
    renderHost({ open: false, automation: null })
    act(() => setHost({ open: true, automation: null }))
    expect(nameInput().value).toBe('')
    expect(screen.getByText('Create')).toBeTruthy()

    fireEvent.change(nameInput(), { target: { value: 'draft' } })
    expect(nameInput().value).toBe('draft')
    act(() => setHost({ open: false, automation: null }))
    act(() => setHost({ open: true, automation: null }))
    expect(nameInput().value).toBe('')

    act(() => setHost({ open: true, automation: a }))
    expect(nameInput().value).toBe('auto a')
    fireEvent.change(nameInput(), { target: { value: 'renamed' } })

    // Same automation object, unrelated re-render → the edit is kept.
    act(() => setHost({ open: true, automation: a }))
    expect(nameInput().value).toBe('renamed')

    // A new automation object (even with equal data) re-seeds the form.
    act(() => setHost({ open: true, automation: { ...a } }))
    expect(nameInput().value).toBe('auto a')

    act(() => setHost({ open: true, automation: automation('b', { description: null }) }))
    expect(nameInput().value).toBe('auto b')
    expect(descInput().value).toBe('')
  })

  it('new automation saves the empty-form defaults once a name + command are filled', () => {
    renderHost({ open: true, automation: null })
    fireEvent.change(nameInput(), { target: { value: 'fresh' } })
    const command = screen.getByPlaceholderText(/command|echo|npm|pnpm/i) as HTMLInputElement
    fireEvent.change(command, { target: { value: 'ls' } })
    act(() => {
      fireEvent.click(screen.getByText('Create'))
    })
    expect(onSave).toHaveBeenCalledWith({
      project_id: 'p1',
      name: 'fresh',
      description: undefined,
      trigger_config: { type: 'task_status_change', params: {} },
      conditions: [],
      actions: [{ type: 'run_command', params: { command: 'ls' } }],
      catchup_on_start: true
    })
  })
})
