// Pins the title row's ⋯ "New panel" choices (docs/plans/panel-model.md step 9):
// every enabled multi-instance kind plus each web panel, in sections; Settings stays single.
import { describe, expect, it } from 'vitest'
import { newPanelChoiceLike, newPanelChoices, newPanelSections } from './NewPanelMenu'

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

  it('groups the choices into Run / Code / Content, dropping empty sections', () => {
    const sections = newPanelSections(newPanelChoices(web, () => true))
    expect(sections.map((s) => [s.label, s.choices.map((c) => c.key)])).toEqual([
      ['Run', ['agent', 'terminal', 'processes']],
      ['Code', ['editor', 'git']],
      ['Content', ['browser', 'artifacts', 'web:docs']]
    ])
    const onlyGit = newPanelSections(newPanelChoices([], (id) => id === 'diff'))
    expect(onlyGit.map((s) => s.label)).toEqual(['Code'])
  })

  it('maps a tab to another panel of the same kind', () => {
    expect(newPanelChoiceLike({ id: 'git:1', kind: 'git', settings: {} }, web)?.kind).toBe('git')
    expect(newPanelChoiceLike({ id: 'settings', kind: 'settings', settings: {} }, web)).toBeNull()
    expect(
      newPanelChoiceLike({ id: 'web:9', kind: 'web', settings: { panelId: 'web:docs' } }, web)
    ).toMatchObject({ label: 'Docs', settings: { panelId: 'web:docs' } })
  })
})
