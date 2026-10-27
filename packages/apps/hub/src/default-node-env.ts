/**
 * Imported FIRST by bin.ts, so it runs before any library loads: NODE_ENV defaults to
 * `production`. Libraries read the real variable at runtime — better-auth captures it
 * at module load, tRPC (`isDev`: stack traces in error replies) and Express (stack
 * traces in error pages) read it when the hub builds them — so a build-time define
 * cannot reach them. A launcher's value wins: the desktop app's sidecar inherits main's
 * (`production` packaged, `development` in dev), an operator may set their own.
 * Unmanifested, so sanitizeSpawnEnv keeps it out of user terminals and processes.
 */
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production'

export {}
