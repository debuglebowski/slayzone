/**
 * The desktop logic the projects, computers and hubs screens reuse, imported the way
 * the app imports it — through the packages' DOM-free subpaths — in React Native's test
 * environment. A module that touches the DOM at import time fails here, and so does any
 * runtime import of a desktop-only package or of a Node built-in (the app's bundler
 * resolves no `node:` module): each is mocked to throw when loaded (type-only imports
 * are erased and never load). Same guard as `../shared-logic.test.ts`, for this set.
 */
import { computerName, computerStatus, inheritComputerLabel } from '@slayzone/computers/labels'
import { pickerStartDir } from '@slayzone/file-editor/dir-picker'
import { DEFAULT_LOCAL_COMPUTER_NAME } from '@slayzone/platform/computer-identity'
import { placementOn, workComputerId } from '@slayzone/projects-contracts/placements'

// Node built-ins: what a server-side module of a shared package pulls in.
jest.mock('node:crypto', () => {
  throw new Error('node:crypto (a Node built-in) loaded')
})
jest.mock('node:fs', () => {
  throw new Error('node:fs (a Node built-in) loaded')
})
jest.mock('node:path', () => {
  throw new Error('node:path (a Node built-in) loaded')
})
jest.mock('node:os', () => {
  throw new Error('node:os (a Node built-in) loaded')
})
jest.mock('@slayzone/ui', () => {
  throw new Error('@slayzone/ui (desktop UI kit) loaded')
})
jest.mock('@slayzone/ui/secure-context', () => {
  throw new Error('@slayzone/ui/secure-context (desktop UI kit) loaded')
})
jest.mock('react-dom', () => {
  throw new Error('react-dom loaded')
})
jest.mock('lucide-react', () => {
  throw new Error('lucide-react (DOM icons) loaded')
})
jest.mock('@slayzone/transport/client', () => {
  throw new Error('@slayzone/transport/client (the tRPC runtime) loaded by pure logic')
})

describe('@slayzone/projects-contracts/placements', () => {
  it("finds a project's folder on the computer its task runs on", () => {
    const project = {
      placements: [{ computer_id: 'mac', path: '/w/app', status: 'ready' as const }],
      resolved_computer_id: 'mac'
    }
    expect(workComputerId({ computer_id: null }, project)).toBe('mac')
    expect(placementOn(project, 'mac')?.path).toBe('/w/app')
  })
})

describe('@slayzone/computers/labels', () => {
  it("names computers and their state in desktop's words", () => {
    const computers = [{ id: 'c1', name: 'mac-mini' }]
    expect(computerName(computers, 'c1')).toBe('mac-mini')
    expect(computerName(computers, null)).toBe('Local')
    expect(inheritComputerLabel('mac-mini')).toBe('Inherit project default (mac-mini)')
    expect(computerStatus({ connected: true, usable: true, lastSeenAt: 1 })).toEqual({
      label: 'Connected',
      tone: 'ok'
    })
    expect(DEFAULT_LOCAL_COMPUTER_NAME).toBe('local-computer')
  })
})

describe('@slayzone/file-editor/dir-picker', () => {
  it('opens the folder picker where desktop opens it', () => {
    expect(
      pickerStartDir({ roots: ['/Users/me'], sep: '/', home: '/Users/me', defaultPath: null })
    ).toBe('/Users/me')
  })
})
