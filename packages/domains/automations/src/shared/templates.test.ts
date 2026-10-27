/**
 * Template resolution tests
 */
import { describe, expect, test } from 'vitest'
import { resolveTemplate, TEMPLATE_VARIABLES, type TemplateContext } from './templates.js'

const fullCtx: TemplateContext = {
  task: {
    id: 't1',
    name: 'Fix login',
    status: 'done',
    priority: 3,
    worktree_path: '/tmp/wt',
    branch: 'fix/login'
  },
  project: { id: 'p1', name: 'SlayZone', path: '/home/user/slayzone' },
  trigger: { old_status: 'todo', new_status: 'done' }
}

describe('resolveTemplate — basic replacement', () => {
  test('replaces {{task.name}}', () => {
    expect(resolveTemplate('Hello {{task.name}}', fullCtx)).toBe('Hello Fix login')
  })

  test('replaces {{project.path}}', () => {
    expect(resolveTemplate('cd {{project.path}}', fullCtx)).toBe('cd /home/user/slayzone')
  })

  test('replaces {{trigger.new_status}}', () => {
    expect(resolveTemplate('status: {{trigger.new_status}}', fullCtx)).toBe('status: done')
  })

  test('replaces {{trigger.old_status}}', () => {
    expect(resolveTemplate('from {{trigger.old_status}}', fullCtx)).toBe('from todo')
  })

  test('replaces {{task.id}}', () => {
    expect(resolveTemplate('{{task.id}}', fullCtx)).toBe('t1')
  })

  test('replaces {{task.branch}}', () => {
    expect(resolveTemplate('{{task.branch}}', fullCtx)).toBe('fix/login')
  })

  test('replaces {{task.worktree_path}}', () => {
    expect(resolveTemplate('{{task.worktree_path}}', fullCtx)).toBe('/tmp/wt')
  })

  test('replaces {{project.name}}', () => {
    expect(resolveTemplate('{{project.name}}', fullCtx)).toBe('SlayZone')
  })
})

describe('resolveTemplate — multiple variables', () => {
  test('replaces multiple different variables', () => {
    expect(resolveTemplate('{{task.name}} in {{project.name}}', fullCtx)).toBe(
      'Fix login in SlayZone'
    )
  })

  test('replaces same variable twice', () => {
    expect(resolveTemplate('{{task.name}} and {{task.name}}', fullCtx)).toBe(
      'Fix login and Fix login'
    )
  })

  test('replaces all groups in one template', () => {
    expect(resolveTemplate('{{task.name}} {{project.path}} {{trigger.old_status}}', fullCtx)).toBe(
      'Fix login /home/user/slayzone todo'
    )
  })
})

describe('resolveTemplate — missing context', () => {
  test('missing task group → empty string', () => {
    expect(resolveTemplate('{{task.name}}', { project: fullCtx.project })).toBe('')
  })

  test('missing project group → empty string', () => {
    expect(resolveTemplate('{{project.path}}', { task: fullCtx.task })).toBe('')
  })

  test('missing trigger group → empty string', () => {
    expect(resolveTemplate('{{trigger.old_status}}', { task: fullCtx.task })).toBe('')
  })

  test('unknown group → empty string', () => {
    expect(resolveTemplate('{{unknown.field}}', fullCtx)).toBe('')
  })

  test('unknown key on valid group → empty string', () => {
    expect(resolveTemplate('{{task.nonexistent}}', fullCtx)).toBe('')
  })

  test('null field value → empty string', () => {
    const ctx: TemplateContext = {
      task: { id: 't1', name: 'X', status: 's', priority: 1, worktree_path: null, branch: null }
    }
    expect(resolveTemplate('{{task.worktree_path}}', ctx)).toBe('')
  })

  test('undefined trigger fields → empty string', () => {
    const ctx: TemplateContext = { trigger: { old_status: undefined, new_status: undefined } }
    expect(resolveTemplate('{{trigger.old_status}}', ctx)).toBe('')
  })
})

describe('resolveTemplate — type coercion', () => {
  test('number field → string', () => {
    expect(resolveTemplate('pri={{task.priority}}', fullCtx)).toBe('pri=3')
  })
})

describe('resolveTemplate — malformed syntax', () => {
  test('single braces → unchanged', () => {
    expect(resolveTemplate('{task.name}', fullCtx)).toBe('{task.name}')
  })

  test('space instead of dot → unchanged', () => {
    expect(resolveTemplate('{{task name}}', fullCtx)).toBe('{{task name}}')
  })

  test('missing key after dot → unchanged', () => {
    expect(resolveTemplate('{{task.}}', fullCtx)).toBe('{{task.}}')
  })

  test('missing group before dot → unchanged', () => {
    expect(resolveTemplate('{{.name}}', fullCtx)).toBe('{{.name}}')
  })

  test('triple braces → partial match', () => {
    // {{{task.name}}} → the inner {{task.name}} matches, outer braces remain
    expect(resolveTemplate('{{{task.name}}}', fullCtx)).toBe('{Fix login}')
  })
})

describe('resolveTemplate — edge cases', () => {
  test('no variables → returned unchanged', () => {
    expect(resolveTemplate('echo hello', fullCtx)).toBe('echo hello')
  })

  test('empty template → empty string', () => {
    expect(resolveTemplate('', fullCtx)).toBe('')
  })

  test('empty context → all vars empty', () => {
    expect(resolveTemplate('{{task.name}} {{project.path}}', {})).toBe(' ')
  })
})

describe('TEMPLATE_VARIABLES — registry', () => {
  test('has 12 entries', () => {
    expect(TEMPLATE_VARIABLES.length).toBe(12)
  })

  test('every name resolves non-empty against full context', () => {
    const ctx: TemplateContext = {
      task: {
        id: 't1',
        name: 'n',
        status: 's',
        priority: 3,
        worktree_path: '/wt',
        branch: 'b',
        terminal_mode: 'claude-code',
        terminal_mode_flags: '--foo'
      },
      project: { id: 'p1', name: 'P', path: '/p' },
      trigger: { old_status: 'o', new_status: 'n' }
    }
    for (const v of TEMPLATE_VARIABLES) {
      const out = resolveTemplate(`{{${v.name}}}`, ctx)
      if (out === '') throw new Error(`${v.name} resolved empty — registry/TemplateContext drift`)
    }
  })
})
