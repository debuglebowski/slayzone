import { describe, expect, it } from 'vitest'
import { TASK_CARD_OMITTED_FIELDS, isFullTaskRow, toCardRow } from './card-row'
import type { Task } from './types'

const row = {
  id: 't',
  title: 'T',
  description: 'd',
  provider_config: {},
  panel_visibility: null
} as unknown as Task

describe('card rows', () => {
  it('drops exactly the omitted fields and keeps the rest', () => {
    const card = toCardRow({ ...row, claude_flags: '' } as Task)
    for (const f of TASK_CARD_OMITTED_FIELDS) expect(f in card).toBe(false)
    expect(card).toMatchObject({ id: 't', title: 'T', panel_visibility: null })
  })

  it('a row with every omitted field is full; a card row is not', () => {
    const full = Object.fromEntries([...TASK_CARD_OMITTED_FIELDS].map((f) => [f, null]))
    expect(isFullTaskRow({ ...row, ...full } as Task)).toBe(true)
    expect(isFullTaskRow(toCardRow(row))).toBe(false)
  })

  it('keeps what an instantly-rendered task page and every card read', () => {
    for (const kept of [
      'panel_visibility',
      'panel_sizes',
      'browser_tabs',
      'browser_url',
      'title',
      'status'
    ])
      expect(TASK_CARD_OMITTED_FIELDS.has(kept as never)).toBe(false)
  })
})
