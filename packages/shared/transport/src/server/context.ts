import type { SlayzoneDb } from '@slayzone/platform'
import type { IncomingMessage } from 'node:http'

export type TrpcServerDeps = {
  db: SlayzoneDb
  dataRoot: string
}

export type TrpcContext = TrpcServerDeps & {
  req?: IncomingMessage
}

export type TrpcContextFactory = (req?: IncomingMessage) => TrpcContext
