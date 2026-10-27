/**
 * setupFiles for vitest.harness.config.ts: runs in every worker before each file.
 *
 * vitest sets TEST=true in its workers. better-auth's isTest() reads it on every call
 * and then skips its Origin/CSRF check, so in-process hubs — and bins spawned with the
 * inherited env — would run with a weaker auth boundary than in production. The old
 * runners never set it.
 */
delete process.env.TEST
