/**
 * What the model and effort pickers offer: the list `chat.getModels` serves
 * (Claude: the fixed list; Codex: what its CLI's `model/list` reported, none
 * before Codex ran once) — never a list hardcoded in the UI for Codex.
 */
import { describe, expect, test } from 'vitest'
import type { ChatModelInfo } from '@slayzone/terminal-contracts'
import { chatModelsView } from './chat-models'

const CODEX: ChatModelInfo[] = [
  {
    id: 'gpt-6-luna',
    label: 'GPT-6 Luna',
    supportsEffort: true,
    isDefault: true,
    efforts: [
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium' },
      { id: 'ultra', label: 'Ultra', description: 'Most reasoning' }
    ],
    defaultEffort: 'medium'
  },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', supportsEffort: false }
]

describe('chat models', () => {
  test('Codex: the served models, their own effort levels', () => {
    const v = chatModelsView('codex-chat', CODEX)
    expect(v.unlisted).toBe(false)
    expect(v.models.map((m) => m.id)).toEqual(['gpt-6-luna', 'gpt-6.1-sol'])
    expect(v.supportsEffort('gpt-6-luna')).toBe(true)
    expect(v.supportsEffort('gpt-6.1-sol')).toBe(false)
    expect(v.effortLevels('gpt-6-luna')?.map((l) => l.id)).toEqual(['low', 'medium', 'ultra'])
    expect(v.label('gpt-6-luna')).toBe('GPT-6 Luna')
  })

  test('Codex before its first run: nothing listed, no effort picker, no hardcoded list', () => {
    for (const served of [[], undefined]) {
      const v = chatModelsView('codex-chat', served)
      expect(v.unlisted).toBe(true)
      expect(v.models).toEqual([])
      expect(v.supportsEffort('gpt-5.5')).toBe(false)
    }
  })

  test('a model the list does not have (an older choice): no effort levels to offer', () => {
    const v = chatModelsView('codex-chat', CODEX)
    expect(v.supportsEffort('gpt-5.5')).toBe(false)
    expect(v.label('gpt-5.5')).toBe('gpt-5.5')
  })

  test('Claude: the fixed list until served, and its own effort levels (the pill default)', () => {
    const v = chatModelsView('claude-chat', undefined)
    expect(v.unlisted).toBe(false)
    expect(v.models.map((m) => m.id)).toEqual(['opus', 'sonnet', 'haiku'])
    expect(v.supportsEffort('opus')).toBe(true)
    expect(v.supportsEffort('haiku')).toBe(false)
    expect(v.effortLevels('opus')).toBeUndefined()
  })
})
