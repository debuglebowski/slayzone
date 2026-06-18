export {
  useTRPC,
  useTRPCClient,
  createTrpcWsClient,
  getTrpcClient,
  initTrpcClient,
  type CreateTrpcClientOpts,
  type TrpcVanillaClient
} from './trpc'
export { TrpcProvider, type TrpcProviderProps } from './provider'
export { electronBootstrap } from './electron-bootstrap'
// Subscription hook for the tanstack integration — single import point so
// renderer code gets it from the transport barrel (not @trpc/* directly).
export { useSubscription } from '@trpc/tanstack-react-query'
// Re-export useQuery so consumers (e.g. the Chromium fork) share the exact
// react-query instance the provider uses — avoids a duplicate module with its
// own QueryClient context.
export { useQuery } from '@tanstack/react-query'
