import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHAT_BODY_TEXT_REM, chatTypeScaleStyle } from './chat-type-scale'

describe('chatTypeScaleStyle', () => {
  it('sizes body text (text-sm) to the chosen px', () => {
    const style = chatTypeScaleStyle(20) as Record<string, string>
    expect(style.fontSize).toBe('20px')
    // 20px / 14px body = scale 20/14; body token = 0.875rem * that = 1.25rem = 20px.
    expect(style['--text-sm']).toBe(`calc(${CHAT_BODY_TEXT_REM}rem * ${20 / 14})`)
  })

  it('scales every text token the chat uses by the same factor', () => {
    const style = chatTypeScaleStyle(28) as Record<string, string>
    for (const token of ['4xs', '3xs', '2xs', 'xs', 'sm', 'base', 'lg', 'xl', '2xl']) {
      expect(style[`--text-${token}`]).toMatch(/\* 2\)$/)
    }
  })
})

/** A fixed px size never follows the chat's font size — use a text-* token. */
describe('chat sources', () => {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path)
    }
  }
  walk(__dirname)

  it('use no fixed-px text sizes', () => {
    const offenders = files.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/\btext-\[\d+(\.\d+)?px\]/g)].map(
        (m) => `${file.slice(__dirname.length + 1)}: ${m[0]}`
      )
    )
    expect(offenders).toEqual([])
  })
})
