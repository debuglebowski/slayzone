export {
  useTRPC,
  useTRPCClient,
  createTrpcWsClient,
  getTrpcClient,
  type CreateTrpcClientOpts,
  type TrpcVanillaClient
} from './trpc'
export { TrpcProvider, type TrpcProviderProps } from './provider'
// Subscription hook for the tanstack integration — single import point so
// renderer code gets it from the transport barrel (not @trpc/* directly).
export { useSubscription } from '@trpc/tanstack-react-query'
