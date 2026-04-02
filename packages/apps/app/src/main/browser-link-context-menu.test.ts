import { describe, expect, it } from 'vitest'
import {
  buildBrowserLinkContextMenuItems,
  normalizeBrowserLinkContextMenuInput,
} from './browser-link-context-menu'

describe('buildBrowserLinkContextMenuItems', () => {
  it('normalizes the raw link context menu input', () => {
    expect(normalizeBrowserLinkContextMenuInput({
      linkURL: '  https://example.com/docs  ',
      linkText: '  Example docs  ',
    })).toEqual({
      linkURL: 'https://example.com/docs',
      linkText: 'Example docs',
    })
  })

  it('returns the minimal link action set for http links', () => {
    expect(buildBrowserLinkContextMenuItems({
      linkURL: 'https://example.com/docs',
      linkText: 'Example docs',
    })).toEqual([
      { action: 'create-task-from-link', label: 'Create Task From Link' },
      { action: 'open-link-in-new-tab', label: 'Open Link in New Tab' },
      { action: 'copy-link', label: 'Copy Link' },
      { action: 'open-link-externally', label: 'Open Link Externally' },
    ])
  })

  it('ignores non-http links', () => {
    expect(buildBrowserLinkContextMenuItems({
      linkURL: 'mailto:test@example.com',
      linkText: 'Mail',
    })).toEqual([])
  })
})
