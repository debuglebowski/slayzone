// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { createTrpcTest } from '@slayzone/transport/testing'
import { useHubTaskSearch } from './useHubTaskSearch'

afterEach(cleanup)

function setup(features: string[]) {
  const asked: unknown[] = []
  const t = createTrpcTest({
    procedures: {
      'hub.describe': () => ({ api: 1, features }),
      'task.search': (input: unknown) => {
        asked.push(input)
        return { tasks: [{ id: 'hit', title: 'Hit' }], hasMore: false }
      }
    }
  })
  return { t, asked }
}

it('asks the hub once typing pauses, and answers its hits', async () => {
  const { t, asked } = setup(['task-search'])
  const { result } = renderHook(() => useHubTaskSearch('needle', true), { wrapper: t.wrapper })
  await waitFor(() => expect(result.current).toEqual([{ id: 'hit', title: 'Hit' }]))
  expect(asked).toEqual([{ query: 'needle', limit: 25 }])
})

it('a hub without task-search is never asked', async () => {
  const { t, asked } = setup([])
  const { result } = renderHook(() => useHubTaskSearch('needle', true), { wrapper: t.wrapper })
  await new Promise((r) => setTimeout(r, 400))
  expect(result.current).toBeUndefined()
  expect(asked).toEqual([])
})

it('a one-letter query stays with the board search', async () => {
  const { t, asked } = setup(['task-search'])
  renderHook(() => useHubTaskSearch('n', true), { wrapper: t.wrapper })
  await new Promise((r) => setTimeout(r, 400))
  expect(asked).toEqual([])
})
