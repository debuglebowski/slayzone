import type { HubComputer } from '../computers/hub-computers'
import { projectOf } from '../hubs/testing'
import { placementStatusText, projectFolders } from './folders'

const computer = (id: string, name = id): HubComputer =>
  ({ id, name, connected: true, usable: true, lastSeenAt: 1, revokedAt: null }) as HubComputer

describe('projectFolders', () => {
  it('lists every computer with its folder, the one the hub uses for the project first', () => {
    const project = projectOf('p', {
      resolved_computer_id: 'mini',
      placements: [
        { computer_id: 'mini', path: '/Users/me/app', status: 'ready' },
        { computer_id: 'laptop', path: '/w/app', status: 'missing' }
      ]
    })
    const folders = projectFolders(project, [computer('laptop'), computer('box'), computer('mini')])
    expect(folders.kind).toBe('per-computer')
    if (folders.kind !== 'per-computer') return
    expect(folders.rows.map((r) => [r.computerId, r.isDefault, r.placement?.path ?? null])).toEqual(
      [
        ['mini', true, '/Users/me/app'],
        ['laptop', false, '/w/app'],
        ['box', false, null]
      ]
    )
    expect(folders.rows[0].name).toBe('mini')
  })

  it('keeps a folder on a computer the hub no longer lists, as an unknown computer', () => {
    const project = projectOf('p', {
      placements: [{ computer_id: 'gone', path: '/old', status: 'pending' }]
    })
    const folders = projectFolders(project, [computer('mini')])
    if (folders.kind !== 'per-computer') throw new Error('expected per-computer folders')
    expect(folders.rows.map((r) => [r.computerId, r.name, r.computer])).toEqual([
      ['mini', 'mini', expect.objectContaining({ id: 'mini' })],
      ['gone', 'Unknown computer', null]
    ])
  })

  it('never shows a folder the user cleared while its computer was away', () => {
    const project = projectOf('p', {
      placements: [{ computer_id: 'mini', path: '/old', status: 'forgotten' }]
    })
    const folders = projectFolders(project, [computer('mini')])
    if (folders.kind !== 'per-computer') throw new Error('expected per-computer folders')
    expect(folders.rows[0].placement).toBeNull()
  })

  it('shows the one folder of a hub from before folders moved to computers', () => {
    const project = { ...projectOf('p'), placements: undefined, path: '/srv/app' }
    expect(projectFolders(project as never, [computer('mini')])).toEqual({
      kind: 'legacy',
      path: '/srv/app'
    })
  })
})

describe('placementStatusText', () => {
  it('says what is wrong with a folder, and nothing for a confirmed one', () => {
    expect(placementStatusText('ready')).toBeNull()
    expect(placementStatusText('pending')).toBe('Waiting for this computer to confirm')
    expect(placementStatusText('missing')).toBe('Folder not found on this computer')
    expect(placementStatusText('refused')).toBe('Outside the folders this computer allows')
  })
})
