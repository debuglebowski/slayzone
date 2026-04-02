import { describe, expect, it } from 'vitest'
import { buildCreateTaskDraftFromBrowserLink } from './create-task-draft'

describe('buildCreateTaskDraftFromBrowserLink', () => {
  it('uses normalized link text for the title and raw url for the description', () => {
    expect(buildCreateTaskDraftFromBrowserLink('https://example.com/docs', '  Docs   Home  ')).toEqual({
      title: 'Link: Docs Home',
      description: 'https://example.com/docs',
    })
  })

  it('falls back to a blank title when the link text is empty', () => {
    expect(buildCreateTaskDraftFromBrowserLink('https://example.com/docs', '   ')).toEqual({
      title: '',
      description: 'https://example.com/docs',
    })
  })
})
