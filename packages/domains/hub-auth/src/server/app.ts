import { toNodeHandler } from 'better-auth/node'
import express, { type Express } from 'express'

/**
 * Structural handler shape — any better-auth instance qualifies. Structural
 * (instead of `HubAuth`) so the express app never constrains which plugins
 * the instance was built with.
 */
export interface FetchHandlerAuth {
  handler: (request: Request) => Promise<Response>
}

/**
 * Express app serving better-auth under `/api/auth/*`. Usable standalone
 * (`createAuthExpressApp(auth).listen(port)`) or mounted into a host app at
 * root (`host.use(createAuthExpressApp(auth))`).
 *
 * Deliberately no body-parser middleware: better-auth consumes the raw
 * request body itself, and an upstream `express.json()` would break it.
 */
export function createAuthExpressApp(auth: FetchHandlerAuth): Express {
  const app = express()
  app.all('/api/auth/{*any}', toNodeHandler(auth))
  return app
}
