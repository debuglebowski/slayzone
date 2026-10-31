import { CHAT_EFFORTS, chatModelsView, chatModesForMode } from '@slayzone/terminal-contracts'
import {
  effortLabel,
  effortOptions,
  modelChipLabel,
  modeLabel,
  modeOptions,
  modelOptions
} from './chat-controls'

describe('chat controls', () => {
  it.each(['claude-chat', 'codex-chat'])(
    'has words for every permission mode the %s catalog offers',
    (mode) => {
      for (const id of chatModesForMode(mode)) expect(modeLabel(id)).not.toBe(id)
    }
  )

  it("offers Claude's auto mode only to an eligible account", () => {
    expect(modeOptions('claude-chat', false).map((o) => o.id)).not.toContain('auto')
    expect(modeOptions('claude-chat', true).map((o) => o.id)).toContain('auto')
  })

  it("lists Claude's models and every Claude effort level", () => {
    const claude = chatModelsView('claude-chat', undefined)
    expect(modelOptions(claude).map((o) => o.label)).toEqual(['Opus', 'Sonnet', 'Haiku'])
    expect(effortOptions().map((o) => o.id)).toEqual(CHAT_EFFORTS)
    expect(effortLabel('xhigh')).toBe('Extra-high')
  })

  it("lists Codex's models as its CLI listed them, and a model's own effort levels", () => {
    const levels = [{ id: 'ultra', label: 'Ultra', description: 'Most reasoning' }]
    const codex = chatModelsView('codex-chat', [
      { id: 'gpt-6-luna', label: 'GPT-6 Luna', supportsEffort: true, efforts: levels }
    ])
    expect(modelOptions(codex).map((o) => o.id)).toEqual(['gpt-6-luna'])
    expect(effortOptions(levels)).toEqual([
      { id: 'ultra', label: 'Ultra', description: 'Most reasoning' }
    ])
    expect(effortLabel('ultra', levels)).toBe('Ultra')
    expect(modelChipLabel(codex, 'gpt-6-luna')).toBe('GPT-6 Luna')
  })

  it('Codex before its first run: no models, the chip says Default', () => {
    const none = chatModelsView('codex-chat', [])
    expect(modelOptions(none)).toEqual([])
    expect(modelChipLabel(none, '')).toBe('Default')
    expect(modelChipLabel(chatModelsView('claude-chat', undefined), null)).toBe('Model')
  })
})
