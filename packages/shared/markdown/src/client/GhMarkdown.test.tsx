// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { GhMarkdown } from './GhMarkdown'

afterEach(cleanup)

describe('GhMarkdown task list checkboxes', () => {
  it('renders unchecked and checked checkboxes', () => {
    const md = '- [ ] unchecked\n- [x] checked'
    const { container } = render(<GhMarkdown>{md}</GhMarkdown>)

    const checkboxes = container.querySelectorAll('input[type="checkbox"]')
    expect(checkboxes).toHaveLength(2)
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(false)
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(true)
  })

  it('adds contains-task-list class to parent ul', () => {
    const md = '- [ ] task item'
    const { container } = render(<GhMarkdown>{md}</GhMarkdown>)

    const ul = container.querySelector('ul.contains-task-list')
    expect(ul).not.toBeNull()
  })

  it('adds task-list-item class to li elements', () => {
    const md = '- [ ] first\n- [x] second'
    const { container } = render(<GhMarkdown>{md}</GhMarkdown>)

    const items = container.querySelectorAll('li.task-list-item')
    expect(items).toHaveLength(2)
  })

  it('does not add task-list classes to regular lists', () => {
    const md = '- regular item\n- another item'
    const { container } = render(<GhMarkdown>{md}</GhMarkdown>)

    expect(container.querySelector('ul.contains-task-list')).toBeNull()
    expect(container.querySelector('li.task-list-item')).toBeNull()
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
  })

  it('does not render checkbox when brackets have no space: - []', () => {
    const md = '- [] Test'
    const { container } = render(<GhMarkdown>{md}</GhMarkdown>)

    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    expect(container.querySelector('ul.contains-task-list')).toBeNull()
  })

  it('renders nested task lists', () => {
    const md = '- [ ] parent\n  - [x] child'
    const { container } = render(<GhMarkdown>{md}</GhMarkdown>)

    const checkboxes = container.querySelectorAll('input[type="checkbox"]')
    expect(checkboxes).toHaveLength(2)

    const nestedUl = container.querySelectorAll('ul.contains-task-list')
    expect(nestedUl.length).toBeGreaterThanOrEqual(1)
  })
})
