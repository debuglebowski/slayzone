/**
 * Skill validation parser tests
 */
import { expect, test } from 'vitest'
import { repairSkillFrontmatter } from '../shared'
import { getSkillValidation } from './skill-validation'

test('missing frontmatter is invalid', () => {
  const validation = getSkillValidation({
    type: 'skill',
    slug: 'x',
    content: '# body'
  })
  expect(validation?.status).toBe('invalid')
})

test('valid frontmatter content is valid', () => {
  const validation = getSkillValidation({
    type: 'skill',
    slug: 'x',
    content: '---\nname: x\ndescription: "a skill"\n---\n# body\n'
  })
  expect(validation?.status).toBe('valid')
})

test('missing description is invalid', () => {
  const validation = getSkillValidation({
    type: 'skill',
    slug: 'x',
    content: '---\nname: x\n---\n# body\n'
  })
  expect(validation?.status).toBe('invalid')
})

test('malformed frontmatter content is invalid', () => {
  const validation = getSkillValidation({
    type: 'skill',
    slug: 'broken',
    content: '---\nname: broken\ntags: [one, two\n---\n# body\n'
  })
  expect(validation?.status).toBe('invalid')
})

test('name mismatch produces a warning', () => {
  const validation = getSkillValidation({
    type: 'skill',
    slug: 'expected-slug',
    content: '---\nname: different-slug\ndescription: "a skill"\n---\n# body\n'
  })
  expect(validation?.status).toBe('warning')
})

test('multiline frontmatter content remains valid', () => {
  const validation = getSkillValidation({
    type: 'skill',
    slug: 'x',
    content: '---\nname: x\ndescription: |\n  line one\n  line two\n---\n# body\n'
  })
  expect(validation?.status).toBe('valid')
})

test('repairSkillFrontmatter adds a valid default block to body-only content', () => {
  const repaired = repairSkillFrontmatter('release-skill', 'Create a new release.\n')
  expect(repaired.startsWith('---\nname: release-skill\n')).toBe(true)
  expect(repaired.includes('trigger: auto')).toBe(true)
  expect(repaired.endsWith('\nCreate a new release.\n')).toBe(true)
})

test('repairSkillFrontmatter preserves body while fixing malformed documents', () => {
  const repaired = repairSkillFrontmatter(
    'release-skill',
    '---\ndescription: Keep this\ntags: [one, two\n---\nBody\n'
  )
  expect(repaired.includes('name: release-skill')).toBe(true)
  expect(repaired.includes('trigger: auto')).toBe(true)
  expect(repaired.includes('\nBody\n')).toBe(true)
})
