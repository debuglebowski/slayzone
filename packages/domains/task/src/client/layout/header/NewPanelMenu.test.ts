// Pins the title row's ⋯ "New panel" choices (docs/plans/panel-model.md step 9):
// every enabled multi-instance kind, a Web page, each web panel, Artifact ▸ per task file
// and Settings' cards on their own (step 12), in sections; Settings stays single.
import { describe, expect, it } from 'vitest'
import { newPanelChoiceLike, newPanelChoices, newPanelSections } from './NewPanelMenu'

const web = [{ id: 'web:docs', name: 'Docs' }]

describe('new panel choices', () => {
  it('lists enabled multi-instance kinds, a web page, web panels, artifacts and task cards', () => {
    const all = newPanelChoices(web, () => true, [{ id: 'a1', title: 'report.html' }])
    expect(all.map((c) => c.key)).toEqual([
      'agent',
      'terminal',
      'browser',
      'editor',
      'git',
      'artifacts',
      'processes',
      'web-page',
      'web:docs',
      'artifact',
      'description',
      'subtasks',
      'details'
    ])
    expect(all.find((c) => c.key === 'web:docs')).toMatchObject({
      kind: 'web',
      label: 'Docs',
      settings: { panelId: 'web:docs' }
    })
    expect(all.find((c) => c.key === 'web-page')).toMatchObject({
      kind: 'web',
      settings: { url: '' }
    })
    expect(all.find((c) => c.key === 'artifact')?.children).toMatchObject([
      { kind: 'artifact', label: 'report.html', settings: { artifactId: 'a1' } }
    ])
    // No files: no Artifact submenu. Settings disabled: no cards either.
    const bare = newPanelChoices([], (id) => id !== 'settings')
    expect(bare.map((c) => c.key)).not.toContain('artifact')
    expect(bare.map((c) => c.key)).not.toContain('description')
    const noBrowser = newPanelChoices([], (id) => id !== 'browser')
    expect(noBrowser.map((c) => c.key)).not.toContain('browser')
  })

  it('groups the choices into Run / Code / Content, dropping empty sections', () => {
    const sections = newPanelSections(newPanelChoices(web, () => true))
    expect(sections.map((s) => [s.label, s.choices.map((c) => c.key)])).toEqual([
      ['Run', ['agent', 'terminal', 'processes']],
      ['Code', ['editor', 'git']],
      ['Content', ['browser', 'artifacts', 'web-page', 'web:docs']],
      ['Task', ['description', 'subtasks', 'details']]
    ])
    const onlyGit = newPanelSections(newPanelChoices([], (id) => id === 'diff'))
    expect(onlyGit.map((s) => s.label)).toEqual(['Code', 'Content'])
  })

  it('maps a tab to another panel of the same kind', () => {
    expect(newPanelChoiceLike({ id: 'git:1', kind: 'git', settings: {} }, web)?.kind).toBe('git')
    expect(newPanelChoiceLike({ id: 'settings', kind: 'settings', settings: {} }, web)).toBeNull()
    expect(
      newPanelChoiceLike({ id: 'description:1', kind: 'description', settings: {} }, web)
    ).toBeNull()
    expect(
      newPanelChoiceLike({ id: 'artifact:1', kind: 'artifact', settings: { artifactId: 'a' } }, web)
    ).toBeNull()
    expect(
      newPanelChoiceLike({ id: 'web:1', kind: 'web', settings: { url: 'https://a.dev/' } }, web)
    ).toMatchObject({ key: 'web-page', settings: { url: '' } })
    expect(
      newPanelChoiceLike({ id: 'web:9', kind: 'web', settings: { panelId: 'web:docs' } }, web)
    ).toMatchObject({ label: 'Docs', settings: { panelId: 'web:docs' } })
  })
})
