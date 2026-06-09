import { describe, expect, it } from 'vitest'
import { DEFAULT_OCCLUSION_POLICY, nativeTileVisible } from './occlusion'
import type { Overlay } from './types'

const dialog: Overlay = { id: 'd', kind: 'dialog', render: () => null }
const menu: Overlay = { id: 'm', kind: 'menu', render: () => null }

describe('nativeTileVisible', () => {
  it('visible when idle', () => {
    expect(nativeTileVisible(DEFAULT_OCCLUSION_POLICY, { overlays: [], draggingSplitId: null })).toBe(true)
  })

  it('hides for an open dialog overlay', () => {
    expect(nativeTileVisible(DEFAULT_OCCLUSION_POLICY, { overlays: [dialog], draggingSplitId: null })).toBe(
      false
    )
  })

  it('does NOT hide for menus/popups (rect-anchored)', () => {
    expect(nativeTileVisible(DEFAULT_OCCLUSION_POLICY, { overlays: [menu], draggingSplitId: null })).toBe(true)
  })

  it('dialogsHideNative=false (native overlay plane era) keeps tiles visible under dialogs', () => {
    expect(
      nativeTileVisible(
        { ...DEFAULT_OCCLUSION_POLICY, dialogsHideNative: false },
        { overlays: [dialog], draggingSplitId: null }
      )
    ).toBe(true)
  })

  it("default 'live' strategy keeps tiles visible during divider drag", () => {
    expect(nativeTileVisible(DEFAULT_OCCLUSION_POLICY, { overlays: [], draggingSplitId: 's1' })).toBe(true)
  })

  it("'hide-during-drag' hides tiles while a divider drags", () => {
    const policy = { ...DEFAULT_OCCLUSION_POLICY, resizeStrategy: 'hide-during-drag' as const }
    expect(nativeTileVisible(policy, { overlays: [], draggingSplitId: 's1' })).toBe(false)
    expect(nativeTileVisible(policy, { overlays: [], draggingSplitId: null })).toBe(true)
  })

  it('hides tiles during a tile drag-rearrange regardless of strategy', () => {
    expect(
      nativeTileVisible(DEFAULT_OCCLUSION_POLICY, {
        overlays: [],
        draggingSplitId: null,
        draggingTileId: 't1'
      })
    ).toBe(false)
  })
})
