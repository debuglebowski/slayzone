import { CHAT_EFFORTS, chatModesForMode } from '@slayzone/terminal-contracts'
import { effortOptions, modeLabel, modeOptions, modelOptions } from './chat-controls'

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

  it("lists the mode's models and every effort level", () => {
    expect(modelOptions('claude-chat').map((o) => o.label)).toEqual(['Opus', 'Sonnet', 'Haiku'])
    expect(effortOptions().map((o) => o.id)).toEqual(CHAT_EFFORTS)
  })
})
