/**
 * chat-effort unit tests
 */
import { expect, test } from 'vitest'
import {
  chatEffortToFlags,
  isChatEffort,
  CHAT_EFFORTS,
  modelSupportsEffort
} from './chat-effort.js'

test('null emits no flags (CLI/account default)', () => {
  expect(chatEffortToFlags(null)).toEqual([])
})

test('undefined emits no flags', () => {
  expect(chatEffortToFlags(undefined)).toEqual([])
})

test('low emits --effort low', () => {
  expect(chatEffortToFlags('low')).toEqual(['--effort', 'low'])
})

test('medium emits --effort medium', () => {
  expect(chatEffortToFlags('medium')).toEqual(['--effort', 'medium'])
})

test('high emits --effort high', () => {
  expect(chatEffortToFlags('high')).toEqual(['--effort', 'high'])
})

test('xhigh emits --effort xhigh', () => {
  expect(chatEffortToFlags('xhigh')).toEqual(['--effort', 'xhigh'])
})

test('max emits --effort max', () => {
  expect(chatEffortToFlags('max')).toEqual(['--effort', 'max'])
})

test('isChatEffort accepts all known levels', () => {
  for (const e of CHAT_EFFORTS) expect(isChatEffort(e)).toBe(true)
})

test('isChatEffort rejects unknown strings', () => {
  expect(isChatEffort('extreme')).toBe(false)
  expect(isChatEffort('')).toBe(false)
  expect(isChatEffort('LOW')).toBe(false)
})

test('isChatEffort rejects non-strings', () => {
  expect(isChatEffort(null)).toBe(false)
  expect(isChatEffort(undefined)).toBe(false)
  expect(isChatEffort(42)).toBe(false)
  expect(isChatEffort({})).toBe(false)
})

test('modelSupportsEffort hides for haiku', () => {
  expect(modelSupportsEffort('haiku')).toBe(false)
})

test('modelSupportsEffort shows for sonnet/opus', () => {
  expect(modelSupportsEffort('sonnet')).toBe(true)
  expect(modelSupportsEffort('opus')).toBe(true)
})
