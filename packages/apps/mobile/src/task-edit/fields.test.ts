import type { TaskTemplate } from '@slayzone/task-contracts'
import { projectOf } from '../hubs/testing'
import {
  applyTemplate,
  dueChoices,
  dueLabel,
  NO_TEMPLATE,
  parseDueDate,
  PRIORITY_CHOICES,
  priorityLabel,
  statusChoices,
  statusLabel,
  templateChoices
} from './fields'

const columns = [
  { id: 'later', label: 'Later', color: 'col-gray', position: 1, category: 'backlog' as const },
  { id: 'now', label: 'Now', color: 'col-blue', position: 0, category: 'started' as const },
  {
    id: 'shipped',
    label: 'Shipped',
    color: 'col-green',
    position: 2,
    category: 'completed' as const
  }
]

const template = (id: string, fields: Partial<TaskTemplate> = {}): TaskTemplate =>
  ({
    id,
    name: id,
    is_default: false,
    default_status: null,
    default_priority: null,
    ...fields
  }) as TaskTemplate

describe('status', () => {
  it("offers the project's own columns in the board's order (by workflow category)", () => {
    const project = projectOf('p', { columns_config: columns })
    expect(statusChoices(project)).toEqual([
      { key: 'later', label: 'Later' },
      { key: 'now', label: 'Now' },
      { key: 'shipped', label: 'Shipped' }
    ])
    expect(statusLabel('later', project)).toBe('Later')
  })

  it('a project without columns has the default workflow', () => {
    const keys = statusChoices(projectOf('p', { columns_config: null })).map((c) => c.key)
    expect(keys).toEqual(['inbox', 'backlog', 'todo', 'in_progress', 'review', 'done', 'canceled'])
    expect(statusLabel('in_progress', undefined)).toBe('In Progress')
  })

  it('an unknown status shows as it is', () => {
    expect(statusLabel('weird', projectOf('p', { columns_config: columns }))).toBe('weird')
  })
})

describe('priority', () => {
  it('offers desktop’s five priorities', () => {
    expect(PRIORITY_CHOICES.map((c) => c.label)).toEqual([
      'Urgent',
      'High',
      'Medium',
      'Low',
      'Someday'
    ])
    expect(priorityLabel(2)).toBe('High')
    expect(priorityLabel(9)).toBe('P9')
  })
})

describe('due date', () => {
  it('offers none, today, tomorrow and next week', () => {
    expect(dueChoices('2026-10-30')).toEqual([
      { key: 'none', label: 'No due date', date: null },
      { key: 'today', label: 'Today', date: '2026-10-30' },
      { key: 'tomorrow', label: 'Tomorrow', date: '2026-10-31' },
      { key: 'week', label: 'In a week', date: '2026-11-06' }
    ])
  })

  it('names a due date', () => {
    expect(dueLabel(null, '2026-10-30')).toBe('No due date')
    expect(dueLabel('2026-10-30', '2026-10-30')).toBe('Due today')
    expect(dueLabel('2026-10-31', '2026-10-30')).toBe('Due tomorrow')
    expect(dueLabel('2026-10-29', '2026-10-30')).toBe('Overdue: 2026-10-29')
    expect(dueLabel('2026-12-01', '2026-10-30')).toBe('Due 2026-12-01')
  })

  it('reads a typed date (YYYY-MM-DD, a real day)', () => {
    expect(parseDueDate(' 2026-02-28 ')).toBe('2026-02-28')
    expect(parseDueDate('2026-02-30')).toBeNull()
    expect(parseDueDate('28.02.2026')).toBeNull()
    expect(parseDueDate('')).toBeNull()
  })
})

describe('templates', () => {
  it("preselects the project's default; no 'No template' then (the hub applies the default anyway)", () => {
    const { choices, initial } = templateChoices([
      template('bug'),
      template('feature', { is_default: true })
    ])
    expect(initial).toBe('feature')
    expect(choices.map((c) => c.key)).toEqual(['bug', 'feature'])
  })

  it("without a default, 'No template' is the first choice and preselected", () => {
    const { choices, initial } = templateChoices([template('bug')])
    expect(initial).toBe(NO_TEMPLATE)
    expect(choices.map((c) => c.key)).toEqual([NO_TEMPLATE, 'bug'])
  })

  it('no templates, no choice', () => {
    expect(templateChoices([])).toEqual({ choices: [], initial: NO_TEMPLATE })
  })

  it('fills status and priority from the template, but not what was chosen or given', () => {
    const t = template('t', { default_status: 'later', default_priority: 1 })
    expect(
      applyTemplate({ status: 'now', priority: 3 }, t, columns, { status: false, priority: false })
    ).toEqual({ status: 'later', priority: 1 })
    expect(
      applyTemplate({ status: 'now', priority: 3 }, t, columns, { status: true, priority: false })
    ).toEqual({ status: 'now', priority: 1 })
  })

  it("ignores a template status the project doesn't have", () => {
    const t = template('t', { default_status: 'gone' })
    expect(
      applyTemplate({ status: 'now', priority: 3 }, t, columns, { status: false, priority: false })
    ).toEqual({ status: 'now', priority: 3 })
  })
})
