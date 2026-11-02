// @vitest-environment jsdom
/**
 * The chat's model and effort pills take their choices from the provider: the
 * effort levels a model lists (Codex `model/list`: any string, e.g. `minimal`),
 * and the models the CLI listed — none yet before Codex ran once ("Default").
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { AgentEffortPill } from './agent-effort-pill'
import { AgentModelPill } from './agent-model-pill'

globalThis.ResizeObserver = class {
  observe() {
    // jsdom: no layout.
  }
  unobserve() {
    // Nothing observed.
  }
  disconnect() {
    // Nothing observed.
  }
}

afterEach(() => cleanup())

const open = (name: RegExp) =>
  fireEvent.keyDown(screen.getByRole('button', { name }), { key: 'Enter' })

describe('effort pill', () => {
  it('offers the levels it is given and names the current one', () => {
    const onChange = vi.fn()
    render(
      <AgentEffortPill
        effort="minimal"
        onChange={onChange}
        levels={[
          { id: 'minimal', label: 'Minimal', description: 'Fastest' },
          { id: 'low', label: 'Low' },
          { id: 'xhigh', label: 'Xhigh' }
        ]}
      />
    )
    expect(screen.getByRole('button', { name: 'Reasoning effort: Minimal' })).toBeTruthy()
    open(/^Reasoning effort/)
    const items = screen.getAllByRole('menuitem').map((el) => el.textContent)
    // Most reasoning first.
    expect(items).toEqual(['Xhigh', 'Low', expect.stringContaining('Minimal')])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Xhigh' }))
    expect(onChange).toHaveBeenCalledWith('xhigh')
  })

  it('without levels: the Claude levels, as before', () => {
    render(<AgentEffortPill effort="high" onChange={() => {}} />)
    open(/^Reasoning effort: High/)
    expect(screen.getAllByRole('menuitem')).toHaveLength(5)
  })
})

describe('model pill', () => {
  it('a provider that listed no models yet: "Default", and why there is nothing to pick', () => {
    render(
      <AgentModelPill
        model=""
        models={[]}
        onChange={() => {}}
        emptyLabel="Default"
        emptyHint="Models load once Codex has started."
      />
    )
    expect(screen.getByRole('button', { name: 'Chat model: Default' })).toBeTruthy()
    open(/^Chat model/)
    expect(document.body.textContent).toContain('Models load once Codex has started.')
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
  })
})

describe('model pill default', () => {
  it('tags the default row; the info pane sets another as default without selecting it', () => {
    const onChange = vi.fn()
    const onSetDefault = vi.fn()
    render(
      <AgentModelPill
        model="opus"
        onChange={onChange}
        defaultModel="sonnet"
        onSetDefault={onSetDefault}
      />
    )
    open(/^Chat model/)
    expect(screen.getByRole('menuitem', { name: /Sonnet/ }).textContent).toContain('default')
    const haiku = screen.getByRole('menuitem', { name: /Haiku/ })
    fireEvent.click(within(haiku).getByRole('button', { name: 'About Haiku' }))
    fireEvent.click(screen.getByRole('button', { name: 'Set as default' }))
    expect(onSetDefault).toHaveBeenCalledWith('haiku')
    expect(onChange).not.toHaveBeenCalled()
  })
})
