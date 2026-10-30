import { act, renderHook, waitFor } from '@testing-library/react-native'
import { pending, trpcTest } from '../testing'
import type { HubComputer } from './hub-computers'
import { useHubComputers } from './use-hub-computers'

const mini = (fields: Partial<HubComputer> = {}): HubComputer =>
  ({
    id: 'mini',
    name: 'mac-mini',
    connected: true,
    usable: true,
    lastSeenAt: 1,
    revokedAt: null,
    ...fields
  }) as HubComputer

describe('useHubComputers', () => {
  it("lists the hub's computers", async () => {
    const { wrapper } = trpcTest({
      procedures: { 'computers.list': () => [mini()] },
      subscriptions: { 'computers.onStatusChange': () => undefined }
    })
    const { result } = await renderHook(() => useHubComputers(), { wrapper })
    await waitFor(() => expect(result.current.computers.map((c) => c.name)).toEqual(['mac-mini']))
    expect(result.current).toMatchObject({ pending: false, error: null })
  })

  it('goes offline live when the hub says a computer disconnected', async () => {
    let online = true
    let emit: (data: unknown) => void = () => undefined
    const { wrapper } = trpcTest({
      procedures: { 'computers.list': () => [mini({ connected: online, usable: online })] },
      subscriptions: {
        'computers.onStatusChange': (_input, push) => {
          emit = push
        }
      }
    })
    const { result } = await renderHook(() => useHubComputers(), { wrapper })
    await waitFor(() => expect(result.current.computers[0]?.usable).toBe(true))

    online = false
    await act(async () => emit({ computerId: 'mini', connected: false }))
    await waitFor(() => expect(result.current.computers[0]?.usable).toBe(false))
  })

  it('reports why the list failed', async () => {
    const { wrapper } = trpcTest({
      procedures: {
        'computers.list': () => {
          throw new Error('hub requires authentication')
        }
      },
      subscriptions: { 'computers.onStatusChange': () => undefined }
    })
    const { result } = await renderHook(() => useHubComputers(), { wrapper })
    await waitFor(() => expect(result.current.error).toBe('hub requires authentication'))
  })

  it('is pending until the list arrives', async () => {
    const { wrapper } = trpcTest({
      procedures: { 'computers.list': pending },
      subscriptions: { 'computers.onStatusChange': () => undefined }
    })
    const { result } = await renderHook(() => useHubComputers(), { wrapper })
    expect(result.current).toMatchObject({ computers: [], pending: true })
  })
})
