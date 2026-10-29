// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { getChromeStyleOverrides, unifiedThemes } from './index'

/** Semantic status + diff tokens every theme must define (chat renderers, DiffView). */
const STATUS_VARS = ['success', 'warning', 'info', 'agent'].flatMap((tone) => [
  `--${tone}`,
  `--${tone}-foreground`,
  `--${tone}-emphasis`,
  `--${tone}-contrast`
])
const DIFF_VARS = [
  '--diff-added',
  '--diff-added-foreground',
  '--diff-removed',
  '--diff-removed-foreground'
]

/** Chrome vars consumed via raw `var()` in CSS only — no Tailwind utility on purpose. */
const NO_UTILITY_VARS = new Set(['--modal-border'])

const variants = unifiedThemes.flatMap((theme) =>
  (['dark', 'light'] as const).flatMap((name) => {
    const variant = theme[name]
    return variant ? [{ label: `${theme.id}/${name}`, chrome: variant.chrome }] : []
  })
)

const themeCss = readFileSync(new URL('../../../theme-css/src/index.css', import.meta.url), 'utf8')

/** Body of the first top-level block whose selector line matches. */
function cssBlock(selector: RegExp): string {
  const start = themeCss.search(selector)
  expect(start, `block ${selector} in theme-css`).toBeGreaterThanOrEqual(0)
  const open = themeCss.indexOf('{', start)
  let depth = 0
  for (let i = open; i < themeCss.length; i++) {
    if (themeCss[i] === '{') depth++
    else if (themeCss[i] === '}' && --depth === 0) return themeCss.slice(open + 1, i)
  }
  throw new Error(`unterminated block ${selector}`)
}

describe('unified themes', () => {
  it.each(variants)('$label maps every chrome color to a CSS var', ({ chrome }) => {
    const overrides = getChromeStyleOverrides(chrome)
    expect(Object.keys(overrides)).toHaveLength(Object.keys(chrome).length)
    for (const name of [...STATUS_VARS, ...DIFF_VARS]) {
      expect(overrides[name], name).toMatch(/\S/)
    }
  })

  it('theme-css exposes every chrome var as a Tailwind color with light + dark fallbacks', () => {
    const themeInline = cssBlock(/^@theme inline\s*\{/m)
    const root = cssBlock(/^:root\s*\{/m)
    const dark = cssBlock(/^\.dark\s*\{/m)
    const names = Object.keys(getChromeStyleOverrides(variants[0].chrome))
    for (const name of names) {
      const decl = new RegExp(`^\\s*${name}:`, 'm')
      expect(root, `:root ${name}`).toMatch(decl)
      expect(dark, `.dark ${name}`).toMatch(decl)
      if (NO_UTILITY_VARS.has(name)) continue
      expect(themeInline, `@theme --color${name.slice(1)}`).toContain(
        `--color-${name.slice(2)}: var(${name});`
      )
    }
  })
})
