// Pins the "New <kind> panel" choices (docs/plans/panel-model.md step 7): every
// enabled multi-instance kind plus each web panel; Settings stays single.
import { describe, expect, it } from 'vitest'
import { newPanelChoiceForToggle, newPanelChoiceLike, newPanelChoices } from './NewPanelMenu'

const web = [{ id: 'web:docs', name: 'Docs' }]

describe('new panel choices', () => {
  it('lists enabled multi-instance kinds, then web panels with their panelId', () => {
    const all = newPanelChoices(web, () => true)
    expect(all.map((c) => c.key)).toEqual([
      'agent',
      'terminal',
      'browser',
      'editor',
      'git',
      'artifacts',
      'processes',
      'web:docs'
    ])
    expect(all.at(-1)).toMatchObject({
      kind: 'web',
      label: 'Docs',
      settings: { panelId: 'web:docs' }
    })
    const noBrowser = newPanelChoices([], (id) => id !== 'browser')
    expect(noBrowser.map((c) => c.key)).not.toContain('browser')
  })

  it('maps a tab or a panel toggle to another panel of the same kind', () => {
    expect(newPanelChoiceLike({ id: 'git:1', kind: 'git', settings: {} }, web)?.kind).toBe('git')
    expect(newPanelChoiceLike({ id: 'settings', kind: 'settings', settings: {} }, web)).toBeNull()
    expect(
      newPanelChoiceLike({ id: 'web:9', kind: 'web', settings: { panelId: 'web:docs' } }, web)
    ).toMatchObject({ label: 'Docs', settings: { panelId: 'web:docs' } })
    expect(newPanelChoiceForToggle('terminal', web)?.kind).toBe('agent')
    expect(newPanelChoiceForToggle('diff', web)?.kind).toBe('git')
    expect(newPanelChoiceForToggle('web:docs', web)?.settings).toEqual({ panelId: 'web:docs' })
    expect(newPanelChoiceForToggle('tests', web)).toBeNull()
  })
})
