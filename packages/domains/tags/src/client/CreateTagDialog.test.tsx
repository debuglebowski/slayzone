// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { createTrpcTest } from '@slayzone/transport/testing'
import { TAG_PRESETS, type Tag } from '@slayzone/tags/shared'

vi.mock('@slayzone/telemetry/client', () => ({ track: vi.fn() }))

import { CreateTagDialog } from './CreateTagDialog'

function tag(id: string, overrides: Partial<Tag> = {}): Tag {
  return {
    id,
    project_id: 'p1',
    name: `tag ${id}`,
    color: TAG_PRESETS[0].bg,
    text_color: TAG_PRESETS[0].text,
    sort_order: 0,
    created_at: '2026-01-01',
    ...overrides
  }
}

interface HostState {
  open: boolean
  tag: Tag | null
}

let wrapper: (props: { children: ReactNode }) => ReactNode
let updates: unknown[]
let creates: unknown[]
let setHost: (next: HostState) => void

function Host({ initial }: { initial: HostState }) {
  const [state, setState] = useState(initial)
  setHost = setState
  return (
    <CreateTagDialog
      open={state.open}
      onOpenChange={(open) => setState((s) => ({ ...s, open }))}
      projectId="p1"
      tag={state.tag}
      onCreated={vi.fn()}
      onUpdated={vi.fn()}
    />
  )
}

function renderHost(initial: HostState) {
  const Wrapper = wrapper
  return render(
    <Wrapper>
      <Host initial={initial} />
    </Wrapper>
  )
}

const nameInput = () => screen.getByPlaceholderText('Tag name') as HTMLInputElement

async function submit(label: 'Save' | 'Create'): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByText(label))
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

beforeEach(() => {
  updates = []
  creates = []
  wrapper = createTrpcTest({
    procedures: {
      'tags.update': (input) => {
        updates.push(input)
        return tag('x')
      },
      'tags.create': (input) => {
        creates.push(input)
        return tag('new')
      }
    }
  }).wrapper
})

afterEach(() => {
  cleanup()
})

describe('CreateTagDialog form seeding', () => {
  it('seeds name + matching preset from the tag at mount', async () => {
    renderHost({ open: true, tag: tag('a') })
    expect(nameInput().value).toBe('tag a')
    await submit('Save')
    expect(updates).toEqual([
      { id: 'a', name: 'tag a', color: TAG_PRESETS[0].bg, textColor: TAG_PRESETS[0].text }
    ])
  })

  it('keeps a custom (non-preset) color', async () => {
    renderHost({ open: true, tag: tag('c', { color: '#123456', text_color: '#abcdef' }) })
    await submit('Save')
    expect(updates).toEqual([{ id: 'c', name: 'tag c', color: '#123456', textColor: '#abcdef' }])
  })

  it('reopening resets edits; same tag object keeps them; a new tag object re-seeds', async () => {
    const a = tag('a')
    renderHost({ open: false, tag: null })
    act(() => setHost({ open: true, tag: null }))
    expect(nameInput().value).toBe('')
    fireEvent.change(nameInput(), { target: { value: 'draft' } })
    act(() => setHost({ open: false, tag: null }))
    act(() => setHost({ open: true, tag: null }))
    expect(nameInput().value).toBe('')

    act(() => setHost({ open: true, tag: a }))
    expect(nameInput().value).toBe('tag a')
    fireEvent.change(nameInput(), { target: { value: 'renamed' } })
    act(() => setHost({ open: true, tag: a }))
    expect(nameInput().value).toBe('renamed')
    act(() => setHost({ open: true, tag: { ...a } }))
    expect(nameInput().value).toBe('tag a')
  })

  it('create uses the default preset', async () => {
    renderHost({ open: true, tag: null })
    fireEvent.change(nameInput(), { target: { value: 'fresh' } })
    await submit('Create')
    expect(creates).toEqual([
      {
        name: 'fresh',
        color: TAG_PRESETS[17].bg,
        textColor: TAG_PRESETS[17].text,
        projectId: 'p1'
      }
    ])
  })
})
