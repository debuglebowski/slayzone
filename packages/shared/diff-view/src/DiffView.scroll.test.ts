// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest'
import { findScrollParent } from './DiffView.scroll'

// Real elements/computed overflow styles; explicit layout geometry stands in for
// the browser layout that jsdom does not perform.
function box(parent: HTMLElement, height: number, contentHeight: number) {
  const element = document.createElement('div')
  element.style.overflowY = 'auto'
  Object.defineProperties(element, {
    clientHeight: { value: height },
    scrollHeight: { value: contentHeight }
  })
  parent.append(element)
  return element
}
afterEach(() => document.body.replaceChildren())

test('large diff uses the bounded vertical viewport beyond an expanding horizontal wrapper', () => {
  const viewport = box(document.body, 600, 1_000_000)
  const horizontal = box(viewport, 1_000_000, 1_000_000)
  horizontal.style.overflowX = 'auto'
  const row = document.createElement('div')
  horizontal.append(row)
  expect(findScrollParent(row)).toBe(viewport)
})

test('an expanding wrapper does not hide an outer virtualizer boundary', () => {
  const viewport = box(document.body, 600, 1_000_000)
  const absolute = document.createElement('div')
  absolute.style.position = 'absolute'
  viewport.append(absolute)
  const horizontal = box(absolute, 1_000_000, 1_000_000)
  const row = document.createElement('div')
  horizontal.append(row)
  expect(findScrollParent(row)).toBeNull()
})

test('nearest actual vertical viewport wins', () => {
  const outer = box(document.body, 600, 10_000)
  const inner = box(outer, 400, 2_000)
  const row = document.createElement('div')
  inner.append(row)
  expect(findScrollParent(row)).toBe(inner)
})

test('no overflow yet retains nearest declared viewport', () => {
  const outer = box(document.body, 600, 600)
  const inner = box(outer, 400, 400)
  const row = document.createElement('div')
  inner.append(row)
  expect(findScrollParent(row)).toBe(inner)
})

test('outer absolute boundary still uses plain rows; missing element has no viewport', () => {
  const viewport = box(document.body, 600, 10_000)
  const row = document.createElement('div')
  row.style.position = 'absolute'
  const sentinel = document.createElement('div')
  row.append(sentinel)
  viewport.append(row)
  expect(findScrollParent(sentinel)).toBeNull()
  expect(findScrollParent(null)).toBeNull()
})
