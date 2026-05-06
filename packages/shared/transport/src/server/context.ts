import type { Database } from 'better-sqlite3'
import type { IncomingMessage } from 'node:http'

export type TrpcServerDeps = {
  db: Database
  dataRoot: string
}

export type TrpcContext = TrpcServerDeps & {
  req?: IncomingMessage
}

export type TrpcContextFactory = (req?: IncomingMessage) => TrpcContext
