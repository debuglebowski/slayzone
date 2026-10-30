// Test seams of the router-agnostic runtime: unit tests of stores that persist
// through tRPC need a stub, or their debounced write fires after the assertions
// and crashes the run on "tRPC client not ready".
export { _resetHubClients, _setTrpcClientSingleton } from './runtime'
// Typed views over the one client runtime — how new code gets a typed client.
// A domain: `typedTrpc<ItsMounts>()`; an app: `trpcFor<AppRouter>()`. See README.md.
export {
  typedTrpc,
  trpcFor,
  trpcBootFor,
  type TrpcView,
  type TrpcBoot,
  type TypedHubWsClient
} from './view'
export { TrpcProvider, makeQueryClient, type TrpcProviderProps } from './provider'
export { setHubConnectProbe, type HubConnectProbe } from './connectPacing'
export {
  FederationProvider,
  useFederation,
  useFederationOrNull,
  FederatedRoot,
  type FederationProviderProps,
  type ResolvedHub,
  type FederatedRootProps
} from './FederationProvider'
export { HubScope, useHubId, type HubScopeProps } from './HubScope'
export {
  toHubConnection,
  useConnectionState,
  useHubConnection,
  type HubConnection
} from './hubConnection'
export { electronBootstrap } from './electron-bootstrap'
export { hubAllows, hubPermitsTelemetry } from './hubCapabilities'
export { useHubRegistryStore } from './hubRegistryStore'
export {
  useHubOwnershipStore,
  getHubIdForProject,
  getHubIdForTask,
  useHubIdForProject,
  useHubIdForTask
} from './hubOwnershipStore'
// Subscription hook for the tanstack integration — single import point so
// renderer code gets it from the transport barrel (not @trpc/* directly).
export { useSubscription } from '@trpc/tanstack-react-query'
// Re-export useQuery so consumers (e.g. the Chromium fork) share the exact
// react-query instance the provider uses — avoids a duplicate module with its
// own QueryClient context.
export { useQuery } from '@tanstack/react-query'
