/**
 * Tests for DOM picker snippet formatting
 */
import { expect, test } from 'vitest'
import { buildDomElementSnippet } from './dom-picker'

test('uses first selector candidate', () => {
  const snippet = buildDomElementSnippet({
    url: 'https://example.com',
    tagName: 'button',
    textSample: 'Checkout',
    selectorCandidates: ['[data-testid="checkout-btn"]', '#checkout-btn']
  })
  expect(snippet).toContain('Element target: [data-testid="checkout-btn"]')
})

test('falls back to tag name if no selectors', () => {
  const snippet = buildDomElementSnippet({
    url: 'https://example.com',
    tagName: 'input',
    textSample: '',
    selectorCandidates: []
  })
  expect(snippet).toContain('Element target: input on https://example.com')
})

test('normalizes and truncates text sample', () => {
  const snippet = buildDomElementSnippet({
    url: 'https://example.com',
    tagName: 'p',
    textSample: ` ${'A'.repeat(200)} \n \t ${'B'.repeat(30)}`,
    selectorCandidates: ['p.content']
  })
  expect(snippet).toContain('Element target: p.content (text="')
  expect(snippet).toContain('…")')
})

test('escapes quotes in text sample', () => {
  const snippet = buildDomElementSnippet({
    url: 'https://example.com',
    tagName: 'button',
    textSample: 'Say "hello"',
    selectorCandidates: ['button']
  })
  expect(snippet).toContain('text="Say \\"hello\\""')
})

test('appends optional note', () => {
  const snippet = buildDomElementSnippet({
    url: 'https://example.com',
    tagName: 'iframe',
    textSample: '',
    selectorCandidates: ['iframe[name="content"]'],
    note: 'Selection came from iframe boundary'
  })
  expect(snippet).toContain('[Selection came from iframe boundary]')
  expect(snippet).not.toContain('text="')
})
