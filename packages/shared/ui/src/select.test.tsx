// @vitest-environment jsdom
import { Activity, memo } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from './select'

afterEach(cleanup)

function StatusSelect({
  mode,
  value,
  onValueChange,
  inForm = false
}: {
  mode: 'visible' | 'hidden'
  value: string
  onValueChange: (value: string) => void
  inForm?: boolean
}): React.JSX.Element {
  const select = (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="inbox">Inbox</SelectItem>
        <SelectItem value="todo">Todo</SelectItem>
        <SelectItem value="review">Review</SelectItem>
      </SelectContent>
    </Select>
  )
  return <Activity mode={mode}>{inForm ? <form>{select}</form> : select}</Activity>
}

describe('Select', () => {
  // Task tabs keep their settings panel in <Activity mode="hidden">. Hiding
  // detaches the trigger ref, so Radix mounts its hidden native <select> with
  // no <option>s. A value change while hidden then makes Radix write that value
  // into the empty <select> on re-show, read back '', and call
  // onValueChange('') — which the task panel saved as status '' (→ Inbox).
  it('does not report a value change when a value set while hidden is re-shown', () => {
    const onValueChange = vi.fn()
    const { rerender } = render(
      <StatusSelect mode="visible" value="todo" onValueChange={onValueChange} />
    )
    rerender(<StatusSelect mode="hidden" value="todo" onValueChange={onValueChange} />)
    rerender(<StatusSelect mode="hidden" value="review" onValueChange={onValueChange} />)
    rerender(<StatusSelect mode="visible" value="review" onValueChange={onValueChange} />)
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('still reports a real selection made through the native form control', () => {
    const onValueChange = vi.fn()
    const { container } = render(
      <StatusSelect mode="visible" value="todo" onValueChange={onValueChange} inForm />
    )
    const native = container.querySelector('select')
    expect(native).not.toBeNull()
    fireEvent.change(native!, { target: { value: 'review' } })
    expect(onValueChange).toHaveBeenCalledWith('review')
  })
})

// Every Radix <SelectItem> of a closed Select used to stay mounted (in a detached
// fragment) only to feed its hidden native <select> and the trigger's label. Under
// <Activity> a task tab's reveal re-ran their ref/layout effects and REMOUNTED all
// of them (Radix creates a new fragment on every re-show): ~680 renders per tab
// switch from the settings panel's four selects. A closed Select now renders its
// selected option's label only; the items mount when it opens, or while its trigger
// has focus (closed-trigger typeahead needs them).
describe('Select: closed selects keep their options unmounted', () => {
  const onLabelRender = vi.fn<(text: string) => void>()
  const renders = (): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const [text] of onLabelRender.mock.calls) out[text] = (out[text] ?? 0) + 1
    return out
  }
  function Label({ text }: { text: string }): React.JSX.Element {
    onLabelRender(text)
    return <>{text}</>
  }
  // memo: re-rendering the test's Activity wrapper must not re-render the select, so
  // only what a re-show itself triggers is counted.
  const ProbedSelect = memo(function ProbedSelect({
    value,
    onValueChange,
    placeholder
  }: {
    value: string | undefined
    onValueChange: (value: string) => void
    placeholder?: string
  }): React.JSX.Element {
    return (
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="inbox">
            <Label text="Inbox" />
          </SelectItem>
          <SelectItem value="todo">
            <Label text="Todo" />
          </SelectItem>
          <SelectItem value="review">
            <Label text="Review" />
          </SelectItem>
        </SelectContent>
      </Select>
    )
  })
  const noop = (): void => {}
  function Probed({
    mode = 'visible',
    value,
    onValueChange = noop,
    placeholder
  }: {
    mode?: 'visible' | 'hidden'
    value: string | undefined
    onValueChange?: (value: string) => void
    placeholder?: string
  }): React.JSX.Element {
    return (
      <Activity mode={mode}>
        <ProbedSelect value={value} onValueChange={onValueChange} placeholder={placeholder} />
      </Activity>
    )
  }
  afterEach(() => onLabelRender.mockClear())

  it('renders only the selected option, as the trigger label', () => {
    render(<Probed value="todo" />)
    expect(screen.getByRole('combobox').textContent).toBe('Todo')
    expect(renders().Inbox ?? 0).toBe(0)
    expect(renders().Review ?? 0).toBe(0)
  })

  it('follows value changes and falls back to the placeholder', () => {
    const { rerender } = render(<Probed value="todo" placeholder="Pick one" />)
    rerender(<Probed value="review" placeholder="Pick one" />)
    expect(screen.getByRole('combobox').textContent).toBe('Review')
    rerender(<Probed value={undefined} placeholder="Pick one" />)
    expect(screen.getByRole('combobox').textContent).toBe('Pick one')
    rerender(<Probed value="inbox" placeholder="Pick one" />)
    expect(screen.getByRole('combobox').textContent).toBe('Inbox')
  })

  it('re-renders none of its options when an Activity re-shows it', () => {
    const { rerender } = render(<Probed value="todo" />)
    rerender(<Probed mode="hidden" value="todo" />)
    onLabelRender.mockClear()
    rerender(<Probed mode="visible" value="todo" />)
    expect(renders()).toEqual({})
    expect(screen.getByRole('combobox').textContent).toBe('Todo')
  })

  it('shows the value set while hidden once re-shown', () => {
    const { rerender } = render(<Probed value="todo" />)
    rerender(<Probed mode="hidden" value="todo" />)
    rerender(<Probed mode="hidden" value="review" />)
    rerender(<Probed mode="visible" value="review" />)
    expect(screen.getByRole('combobox').textContent).toBe('Review')
  })

  it('keeps typeahead on a focused closed trigger', () => {
    const onValueChange = vi.fn()
    render(<Probed value="todo" onValueChange={onValueChange} />)
    const trigger = screen.getByRole('combobox')
    act(() => trigger.focus())
    fireEvent.keyDown(trigger, { key: 'r' })
    expect(onValueChange).toHaveBeenCalledWith('review')
  })

  it('mounts every option when opened', () => {
    // jsdom has no layout; Radix scrolls the selected option into view on open.
    Element.prototype.scrollIntoView ??= () => {}
    render(<Probed value="todo" />)
    const trigger = screen.getByRole('combobox')
    act(() => trigger.focus())
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Inbox',
      'Todo',
      'Review'
    ])
  })

  it("shows an uncontrolled select's default and picked values", () => {
    Element.prototype.scrollIntoView ??= () => {}
    render(
      <Select defaultValue="todo">
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Statuses</SelectLabel>
            <SelectItem value="todo">Todo</SelectItem>
            <SelectSeparator />
            <SelectItem value="review">Review</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    )
    const trigger = screen.getByRole('combobox')
    expect(trigger.textContent).toBe('Todo')
    act(() => trigger.focus())
    fireEvent.keyDown(trigger, { key: 'Enter' })
    fireEvent.click(screen.getByRole('option', { name: 'Review' }))
    act(() => trigger.blur())
    expect(screen.queryByRole('option')).toBeNull()
    expect(trigger.textContent).toBe('Review')
  })

  it('shows explicit SelectValue children instead of the option', () => {
    const WithValue = ({ custom }: { custom?: string }): React.JSX.Element => (
      <Select value="todo">
        <SelectTrigger>
          <SelectValue>{custom}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="todo">Todo</SelectItem>
        </SelectContent>
      </Select>
    )
    const { rerender } = render(<WithValue custom="Custom" />)
    expect(screen.getByRole('combobox').textContent).toBe('Custom')
    rerender(<WithValue />)
    expect(screen.getByRole('combobox').textContent).toBe('Todo')
    rerender(<WithValue custom="Custom" />)
    expect(screen.getByRole('combobox').textContent).toBe('Custom')
  })
})
