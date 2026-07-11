# @slayzone/hub-auth

BetterAuth-backed auth for the SlayZone hub: user sessions (email/password +
bearer tokens), JWT issuance, organizations, and runner API keys. Fully
isolated sub-app — it owns its own sqlite file and never touches the app's
`SlayzoneDb` or migration registry.

Currently DARK: nothing mounts this package yet.

## Pinned versions

| Package | Version |
| --- | --- |
| `better-auth` | `1.6.23` (exact pin) |
| `@better-auth/api-key` | `1.6.23` (exact pin) |

Both are pinned exactly because the schema snapshot below and the adapter
behavior are version-specific. Bump them together and regenerate the snapshot
(`getMigrations(auth.options).compileMigrations()`).

Note: on better-auth 1.6.x the `apiKey` plugin is NOT exported from
`better-auth/plugins` — it moved to the separate `@better-auth/api-key`
package. `bearer`, `jwt`, and `organization` still come from
`better-auth/plugins`.

## Storage / driver choice

- Own sqlite file, path injected via `createHubAuth({ dbPath })`
  (convention: `hub-auth.sqlite`). WAL mode enabled at open.
- Driver: **`node:sqlite` (`DatabaseSync`)**, passed directly as
  `betterAuth({ database })`. better-auth 1.6.23 accepts a `DatabaseSync`
  handle first-class and wraps it in its own kysely `NodeSqliteDialect`
  (`@better-auth/kysely-adapter`), so no manual dialect construction is
  needed.
- Why not better-sqlite3 (the spec's first choice): this repo's postinstall
  rebuilds better-sqlite3 against **Electron's ABI**, so the module
  ERR_DLOPEN-fails under plain node (vitest, CI, scripts). `node:sqlite` is
  ABI-proof and verified working under both plain node 24 and Electron 41's
  node (v24.14). This is the spec-sanctioned fallback ("Kysely node:sqlite
  dialect"), except better-auth's adapter supplies the dialect itself.
- Migrations: better-auth's own programmatic mechanism —
  `getMigrations(auth.options)` from `better-auth/db/migration` (on 1.6.23
  the function lives on that subpath, not on `better-auth/db`), with
  `runMigrations()` executed inside `createHubAuth()` at startup. Idempotent;
  NOT part of the app's migration registry.

## Surface

- `createHubAuth({ dbPath, baseURL, secret })` → better-auth instance with
  plugins `bearer`, `jwt`, `organization`, `apiKey` (metadata enabled,
  key prefix `szr_`). Telemetry pinned off.
- `createAuthExpressApp(auth)` → express app serving `/api/auth/*` via
  `toNodeHandler`. Standalone or mountable at a host app's root. No body
  parser on purpose (better-auth consumes the raw body).
- `verifySession(auth, headers)` / `requireSession(auth)` → resolves
  `HubAuthContext { userId, orgId, session }` from a session cookie or
  `Authorization: Bearer <session-token>`; middleware attaches it as
  `res.locals.hubAuth` (accessor: `getHubAuthContext(res)`).
- `verifyRunnerApiKey(auth, key)` / `requireApiKey(auth)` → resolves
  `RunnerPrincipal { runnerId, keyId }` from the `x-api-key` header; only
  accepts keys minted with runner metadata; middleware attaches it as
  `res.locals.runner` (accessor: `getRunnerPrincipal(res)`).
- `mintRunnerApiKey(auth, { runnerId, name })` / `revokeRunnerApiKey(auth,
  keyId)` → runner keys are owned by an internal service user
  (`runners@slayzone.internal`, created lazily) because the api-key plugin
  requires a user reference; the runner identity is stored as `{ runnerId }`
  key metadata. Revocation deletes the key row through `auth.$context`'s
  adapter because the plugin's `/api-key/delete` endpoint is session-bound
  and runner keys are managed server-side.

## Schema snapshot (better-auth 1.6.23 + plugins, sqlite)

Generated with `compileMigrations()` on a fresh database:

```sql
create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);

create table "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade, "activeOrganizationId" text);

create table "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);

create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);

create table "jwks" ("id" text not null primary key, "publicKey" text not null, "privateKey" text not null, "createdAt" date not null, "expiresAt" date);

create table "organization" ("id" text not null primary key, "name" text not null, "slug" text not null unique, "logo" text, "createdAt" date not null, "metadata" text);

create table "member" ("id" text not null primary key, "organizationId" text not null references "organization" ("id") on delete cascade, "userId" text not null references "user" ("id") on delete cascade, "role" text not null, "createdAt" date not null);

create table "invitation" ("id" text not null primary key, "organizationId" text not null references "organization" ("id") on delete cascade, "email" text not null, "role" text, "status" text not null, "expiresAt" date not null, "createdAt" date not null, "inviterId" text not null references "user" ("id") on delete cascade);

create table "apikey" ("id" text not null primary key, "configId" text not null, "name" text, "start" text, "referenceId" text not null, "prefix" text, "key" text not null, "refillInterval" integer, "refillAmount" integer, "lastRefillAt" date, "enabled" integer, "rateLimitEnabled" integer, "rateLimitTimeWindow" integer, "rateLimitMax" integer, "requestCount" integer, "remaining" integer, "lastRequest" date, "expiresAt" date, "createdAt" date not null, "updatedAt" date not null, "permissions" text, "metadata" text);

create index "session_userId_idx" on "session" ("userId");

create index "account_userId_idx" on "account" ("userId");

create index "verification_identifier_idx" on "verification" ("identifier");

create unique index "organization_slug_uidx" on "organization" ("slug");

create index "member_organizationId_idx" on "member" ("organizationId");

create index "member_userId_idx" on "member" ("userId");

create index "invitation_organizationId_idx" on "invitation" ("organizationId");

create index "invitation_email_idx" on "invitation" ("email");

create index "apikey_configId_idx" on "apikey" ("configId");

create index "apikey_referenceId_idx" on "apikey" ("referenceId");

create index "apikey_key_idx" on "apikey" ("key");
```

## Tests

`pnpm --filter @slayzone/hub-auth test` — vitest, temp-dir sqlite, no
network, no app. Covers migrations, sign-up/sign-in via in-process
`auth.api`, bearer-token verification, apiKey mint/verify/revoke, and
organization create + member add.
