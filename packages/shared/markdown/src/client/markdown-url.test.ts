import { describe, expect, it } from 'vitest'
import { markdownUrlTransform } from './markdown-url'

describe('markdownUrlTransform', () => {
  it('keeps web, mail, relative and path links', () => {
    for (const url of [
      'https://x.dev/a',
      'http://x.dev',
      'mailto:a@b.c',
      '/Users/me/x.ts:12',
      'packages/x.ts:12',
      '../notes.md',
      '#chat-thread:t1'
    ])
      expect(markdownUrlTransform(url)).toBe(url)
  })

  it('keeps the app link schemes the chat opens in-app', () => {
    for (const url of [
      'artifact:6a297ef2-d4e5',
      'slayzone://task/3ad62499',
      'file:///Users/me/x.ts'
    ])
      expect(markdownUrlTransform(url)).toBe(url)
  })

  it('still drops script-capable and unknown schemes', () => {
    for (const url of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>1</script>',
      'vbscript:x',
      'figma://file/x'
    ])
      expect(markdownUrlTransform(url)).toBe('')
  })
})
