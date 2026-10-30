import { hubEntryOf } from './hub-session'
import { agentHref, findSession, taskHref } from './routes'

describe('routes', () => {
  it('names a task by its hub address and id (deep link slayzone://task/<hub>/<id>)', () => {
    expect(taskHref('hub.example.com', 'abc-123')).toBe('/task/hub.example.com/abc-123')
    expect(taskHref('127.0.0.1:8788', 'abc')).toBe('/task/127.0.0.1%3A8788/abc')
    expect(taskHref('[::1]:8788', 'a/b')).toBe('/task/%5B%3A%3A1%5D%3A8788/a%2Fb')
  })

  it('names an agent session the same way', () => {
    expect(agentHref('hub.example.com', 's1')).toBe('/agent/hub.example.com/s1')
  })

  it('finds the session of a hub address from a route', () => {
    const sessions = [
      { entry: hubEntryOf('home.example'), token: 'a' },
      { entry: hubEntryOf('work.example:8788'), token: 'b' }
    ]
    expect(findSession(sessions, 'work.example:8788')?.token).toBe('b')
    expect(findSession(sessions, 'other.example')).toBeUndefined()
    expect(findSession(sessions, undefined)).toBeUndefined()
  })
})
