// @vitest-environment jsdom
// Folder expand state: persisted per task; with nothing persisted, every folder is
// expanded once the folders load (and that set is persisted).
import { Activity, useLayoutEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { ArtifactFolder } from '@slayzone/task/shared'
import { useArtifactTree } from './useArtifactTree'

const KEY = 'slayzone:artifacts-panel:expanded:t1'
const folder = (id: string, parent_id: string | null = null): ArtifactFolder =>
  ({ id, task_id: 't1', name: id, parent_id }) as ArtifactFolder
const FOLDERS = [folder('f1'), folder('f2', 'f1')]
const NO_FOLDERS: ArtifactFolder[] = []
const PATHS = new Map<string, string>()

let latest: ReturnType<typeof useArtifactTree>
/** The expand set as of every commit (what the tree actually painted from). */
let committed: Array<string[] | null>

function Probe({ folders }: { folders: ArtifactFolder[] }) {
  latest = useArtifactTree({ taskId: 't1', folders, artifacts: [], folderPathMap: PATHS })
  const expanded = latest.expandedFolders
  useLayoutEffect(() => {
    committed.push(expanded ? [...expanded].sort() : null)
  })
  return null
}

function Tab({ mode, folders }: { mode: 'visible' | 'hidden'; folders: ArtifactFolder[] }) {
  return (
    <Activity mode={mode}>
      <Probe folders={folders} />
    </Activity>
  )
}

const persisted = () => JSON.parse(window.localStorage.getItem(KEY) ?? 'null')

beforeEach(() => {
  window.localStorage.clear()
  committed = []
})
afterEach(cleanup)

describe('useArtifactTree expand state', () => {
  it('expands and persists every folder on first load when nothing is persisted', () => {
    const view = render(<Tab mode="visible" folders={NO_FOLDERS} />)
    expect(latest.expandedFolders).toBeNull()
    expect(persisted()).toBeNull()

    view.rerender(<Tab mode="visible" folders={FOLDERS} />)
    expect([...(latest.expandedFolders ?? [])].sort()).toEqual(['f1', 'f2'])
    expect(persisted().sort()).toEqual(['f1', 'f2'])
  })

  it('keeps a persisted expand set (no auto-expand over it)', () => {
    window.localStorage.setItem(KEY, JSON.stringify(['f2']))
    render(<Tab mode="visible" folders={FOLDERS} />)
    expect([...(latest.expandedFolders ?? [])]).toEqual(['f2'])
    expect(persisted()).toEqual(['f2'])
  })

  it('persists a toggle, and keeps it across a tab switch', () => {
    const view = render(<Tab mode="visible" folders={FOLDERS} />)
    act(() => latest.toggleFolder('f1'))
    expect([...(latest.expandedFolders ?? [])]).toEqual(['f2'])
    expect(persisted()).toEqual(['f2'])

    view.rerender(<Tab mode="hidden" folders={FOLDERS} />)
    view.rerender(<Tab mode="visible" folders={FOLDERS} />)
    expect([...(latest.expandedFolders ?? [])]).toEqual(['f2'])
    expect(persisted()).toEqual(['f2'])
  })

  it('never commits loaded folders with the expand set still unresolved', () => {
    const view = render(<Tab mode="visible" folders={NO_FOLDERS} />)
    view.rerender(<Tab mode="visible" folders={FOLDERS} />)
    expect(committed).toEqual([null, ['f1', 'f2']])
  })

  it('folders loaded at mount: the first commit is already expanded', () => {
    render(<Tab mode="visible" folders={FOLDERS} />)
    expect(committed).toEqual([['f1', 'f2']])
  })
})
