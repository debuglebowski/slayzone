import { ChevronRight } from 'lucide-react'
import { Button, cn } from '@slayzone/ui'
import type { IntegrationsTabModel } from './useIntegrationsTab'

export function IntegrationCategoryGrid({ vm }: { vm: IntegrationsTabModel }) {
  const {
    activeSyncProvider,
    connections,
    disconnectingProjectConnectionProvider,
    githubConnected,
    githubConnections,
    githubProjectConnectionId,
    handleDisconnectProjectConnection,
    handleSelectIntegrationEntry,
    integrationCategoryItems,
    linearConnected,
    linearProjectConnectionId,
    setConnectionModalState
  } = vm
  return (
    <div className="space-y-3">
      <div className="space-y-6">
        {integrationCategoryItems.map((category) => {
          const providerConnection =
            category.provider === 'github'
              ? (githubConnections.find(
                  (connection) => connection.id === githubProjectConnectionId
                ) ?? null)
              : (connections.find((connection) => connection.id === linearProjectConnectionId) ??
                null)
          const providerConnected = Boolean(providerConnection)

          return (
            <div key={category.provider} className="space-y-2">
              <div className="flex items-center justify-between gap-3 px-0.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold">{category.title}</p>
                    <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
                      Beta
                    </span>
                    {providerConnected ? (
                      providerConnection?.auth_error ? (
                        <button
                          type="button"
                          data-testid={`project-${category.provider}-category-auth-expired`}
                          onClick={() =>
                            setConnectionModalState({
                              provider: category.provider,
                              mode: 'edit'
                            })
                          }
                          className="rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive hover:bg-destructive/25"
                          title={providerConnection.auth_error}
                        >
                          Authentication expired — click to reconnect
                        </button>
                      ) : (
                        <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
                          Connected
                        </span>
                      )
                    ) : null}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {providerConnected ? (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        data-testid={`project-${category.provider}-category-connection`}
                        onClick={() =>
                          setConnectionModalState({ provider: category.provider, mode: 'edit' })
                        }
                        disabled={disconnectingProjectConnectionProvider === category.provider}
                      >
                        Edit connection
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        data-testid={`project-${category.provider}-category-disconnect`}
                        onClick={() => void handleDisconnectProjectConnection(category.provider)}
                        disabled={disconnectingProjectConnectionProvider === category.provider}
                      >
                        {disconnectingProjectConnectionProvider === category.provider
                          ? 'Disconnecting\u2026'
                          : 'Disconnect'}
                      </Button>
                    </>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      data-testid={`project-${category.provider}-category-connection`}
                      onClick={() =>
                        setConnectionModalState({
                          provider: category.provider,
                          mode: 'connect'
                        })
                      }
                    >
                      Connect
                    </Button>
                  )}
                </div>
              </div>
              <div className="space-y-1.5">
                {category.items.map((item) => {
                  const isContinuousActive =
                    item.mode === 'continuous' && activeSyncProvider === category.provider
                  const disabledByOtherProvider =
                    item.mode === 'continuous' &&
                    Boolean(activeSyncProvider) &&
                    activeSyncProvider !== category.provider
                  const connectionReady =
                    category.provider === 'github' ? githubConnected : linearConnected
                  const disabledByMissingConnection = !connectionReady
                  const isItemDisabled = item.disabled || disabledByMissingConnection

                  let stateLabel = ''
                  if (disabledByOtherProvider) {
                    stateLabel =
                      activeSyncProvider === 'github' ? 'Disabled by GitHub' : 'Disabled by Linear'
                  } else if (isContinuousActive) {
                    stateLabel = 'Active'
                  } else if (disabledByMissingConnection) {
                    stateLabel = 'Connect to start using'
                  } else if (connectionReady) {
                    stateLabel = 'Connected'
                  }

                  const stateClass = isContinuousActive
                    ? 'bg-emerald-500/15 text-emerald-300'
                    : disabledByOtherProvider
                      ? 'bg-muted text-muted-foreground'
                      : connectionReady
                        ? 'bg-emerald-500/15 text-emerald-300'
                        : 'bg-muted/70 text-muted-foreground'
                  const hideConnectedPillForImport =
                    item.mode === 'import' && stateLabel === 'Connected'
                  const showStatePill = Boolean(stateLabel) && !hideConnectedPillForImport

                  return (
                    <button
                      key={item.key}
                      type="button"
                      title={item.description}
                      data-testid={item.testId}
                      onClick={() => handleSelectIntegrationEntry(item.entry, { mode: item.mode })}
                      disabled={isItemDisabled}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-md border p-3 text-left transition-colors hover:bg-muted/50',
                        isItemDisabled && 'cursor-not-allowed opacity-50'
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium">{item.label}</p>
                          {showStatePill ? (
                            <span
                              className={cn(
                                'rounded px-1.5 py-0.5 text-[10px] font-medium',
                                stateClass
                              )}
                            >
                              {stateLabel}
                            </span>
                          ) : null}
                        </div>
                        <p className="text-xs text-muted-foreground">{item.description}</p>
                      </div>
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
