// @vitest-environment jsdom
import { Activity } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select'

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
