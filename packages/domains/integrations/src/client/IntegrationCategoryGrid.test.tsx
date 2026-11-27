// @vitest-environment jsdom
/**
 * A connection the hub cannot decrypt says WHY on its badge (the key is not on this
 * machine; the desktop keychain is out of reach), not the generic "expired".
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { CREDENTIAL_KEY_UNAVAILABLE_ERROR } from '../shared'
import { IntegrationCategoryGrid } from './IntegrationCategoryGrid'
import type { IntegrationsTabModel } from './useIntegrationsTab'

afterEach(cleanup)

function vm(authError: string | null): IntegrationsTabModel {
  return {
    activeSyncProvider: null,
    connections: [
      {
        id: 'c1',
        provider: 'linear',
        enabled: authError === null,
        created_at: '',
        updated_at: '',
        last_synced_at: null,
        auth_error: authError,
        auth_error_at: null
      }
    ],
    disconnectingProjectConnectionProvider: null,
    githubConnected: false,
    githubConnections: [],
    githubProjectConnectionId: null,
    handleDisconnectProjectConnection: () => {},
    handleSelectIntegrationEntry: () => {},
    integrationCategoryItems: [{ provider: 'linear', title: 'Linear', items: [] }],
    linearConnected: true,
    linearProjectConnectionId: 'c1',
    setConnectionModalState: () => {}
  } as unknown as IntegrationsTabModel
}

describe('IntegrationCategoryGrid reconnect badge', () => {
  it('a missing key says so', () => {
    render(<IntegrationCategoryGrid vm={vm(CREDENTIAL_KEY_UNAVAILABLE_ERROR)} />)
    expect(screen.getByTestId('project-linear-category-auth-expired').textContent).toBe(
      CREDENTIAL_KEY_UNAVAILABLE_ERROR
    )
  })

  it('a provider auth error keeps the generic text', () => {
    render(<IntegrationCategoryGrid vm={vm('401 Unauthorized')} />)
    expect(screen.getByTestId('project-linear-category-auth-expired').textContent).toBe(
      'Authentication expired — click to reconnect'
    )
  })
})
