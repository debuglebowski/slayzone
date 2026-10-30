import { DEFAULT_BOARD_FILTER } from './board-model'
import { createBoardPrefs, DEFAULT_BOARD_PREFS } from './board-prefs'

function memory(initial: string | null = null) {
  let text = initial
  return { read: () => text, write: (t: string) => void (text = t), text: () => text }
}

describe('board prefs', () => {
  it('keeps the chosen project, view and per-project filters across launches', () => {
    const storage = memory()
    const prefs = createBoardPrefs(storage)
    expect(prefs.load()).toEqual(DEFAULT_BOARD_PREFS)
    prefs.save({
      project: { hubId: 'h', projectId: 'p' },
      view: 'tree',
      filters: { 'h\np': { ...DEFAULT_BOARD_FILTER, priority: 2 } }
    })
    expect(createBoardPrefs(storage).load()).toEqual({
      project: { hubId: 'h', projectId: 'p' },
      view: 'tree',
      filters: { 'h\np': { ...DEFAULT_BOARD_FILTER, priority: 2 } }
    })
  })

  it('reads an unreadable or foreign file as nothing kept, and fills missing filter fields', () => {
    expect(createBoardPrefs(memory('{oops')).load()).toEqual(DEFAULT_BOARD_PREFS)
    expect(createBoardPrefs(memory('{"view":"grid","project":{"hubId":1}}')).load()).toEqual(
      DEFAULT_BOARD_PREFS
    )
    expect(
      createBoardPrefs(memory('{"view":"list","filters":{"k":{"showDone":false}}}')).load()
    ).toEqual({
      ...DEFAULT_BOARD_PREFS,
      view: 'list',
      filters: { k: { ...DEFAULT_BOARD_FILTER, showDone: false } }
    })
  })

  it('a storage that throws keeps nothing and breaks nothing', () => {
    const prefs = createBoardPrefs({
      read: () => {
        throw new Error('io')
      },
      write: () => {
        throw new Error('io')
      }
    })
    expect(prefs.load()).toEqual(DEFAULT_BOARD_PREFS)
    expect(() => prefs.save(DEFAULT_BOARD_PREFS)).not.toThrow()
  })
})
