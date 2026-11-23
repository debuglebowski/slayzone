import { closeTask, combineOpenTasks, openTask, shownTab, type OpenTasks } from './open-tasks'

const ref = (hubId: string, taskId: string) => ({ hubId, taskId })
const empty: OpenTasks = { tabs: [], active: null }

describe('open tasks (iPad tab bar)', () => {
  it('opens a task as a tab and shows it; opening it again only shows it', () => {
    const one = openTask(empty, ref('h', 'a'))
    const two = openTask(one, ref('h', 'b'))
    expect(two.tabs.map((t) => t.taskId)).toEqual(['a', 'b'])
    expect(two.active).toEqual(ref('h', 'b'))
    const again = openTask(two, ref('h', 'a'))
    expect(again.tabs.map((t) => t.taskId)).toEqual(['a', 'b'])
    expect(again.active).toEqual(ref('h', 'a'))
  })

  it('keeps hubs apart (same task id on two hubs = two tabs)', () => {
    const s = openTask(openTask(empty, ref('h', 'a')), ref('w', 'a'))
    expect(s.tabs).toHaveLength(2)
  })

  it('closing the shown tab shows its neighbour, the last one the board', () => {
    const s = openTask(openTask(openTask(empty, ref('h', 'a')), ref('h', 'b')), ref('h', 'c'))
    const closedB = closeTask({ ...s, active: ref('h', 'b') }, ref('h', 'b'))
    expect(closedB.tabs.map((t) => t.taskId)).toEqual(['a', 'c'])
    expect(closedB.active).toEqual(ref('h', 'c'))
    const closedOther = closeTask(s, ref('h', 'a'))
    expect(closedOther.active).toEqual(ref('h', 'c'))
    const last = closeTask({ tabs: [ref('h', 'a')], active: ref('h', 'a') }, ref('h', 'a'))
    expect(last).toEqual(empty)
  })
})

describe('shared open tasks (each hub keeps the user’s tabs of its tasks)', () => {
  it('a synced hub shows its list; a hub that does not keep one shows the tabs opened here', () => {
    const tabs = combineOpenTasks(
      ['h', 'old', 'w'],
      new Map([
        ['h', ['a', 'b']],
        ['w', ['c']]
      ]),
      [ref('old', 'x'), ref('h', 'stale')]
    )
    expect(tabs).toEqual([ref('h', 'a'), ref('h', 'b'), ref('old', 'x'), ref('w', 'c')])
  })

  it('the shown tab, once closed elsewhere, shows the board', () => {
    expect(shownTab([ref('h', 'a')], ref('h', 'a'))).toEqual(ref('h', 'a'))
    expect(shownTab([ref('h', 'a')], ref('h', 'gone'))).toBeNull()
    expect(shownTab([], null)).toBeNull()
  })
})
