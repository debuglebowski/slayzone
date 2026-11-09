# Hub SSO and roles from the identity provider

Two independent things a hub operator configures:

1. **SSO sign-in** — Microsoft Entra ID through its tenant settings, or **any OpenID
   Connect provider** (Okta, Keycloak, Auth0, Google, Entra, …) through the generic
   settings.
2. **The IdP-role mode** (optional, **off by default**) — every hub role comes from the
   identity provider, is re-proven at least every hour, and cannot be changed inside the
   hub. It implements the shared contract `@normain/idp-role-contract` 0.1.0, the same
   release Kahuna and Cloudable use (`vendor/README.md` has the SHA-256).

Code: `packages/domains/hub-auth/src/server/entra.ts` (OIDC sign-in), `idp-roles.ts`
(the mode's adapter), `verify.ts` (the gate); hub: `boot-rules.ts` (B7, B20),
`trpc-connections.ts`, `cli-relay.ts`, `direct-link.ts`, `web-sessions.ts`.

## 1. SSO sign-in

SSO needs `SLAYZONE_HUB_REQUIRE_LOGIN=1`, `SLAYZONE_HUB_ENABLE_SSO=1` and
`SLAYZONE_HUB_PUBLIC_ADDRESS`. Set **one** of the two setups; both together refuse boot (B7).

### Entra tenant setup (unchanged)

| Variable | Meaning |
| --- | --- |
| `SLAYZONE_HUB_SSO_TENANT_ID` | Directory (tenant) id, a GUID |
| `SLAYZONE_HUB_SSO_CLIENT_ID` | Application (client) id, a GUID |
| `SLAYZONE_HUB_SSO_CERT_PATH` / `_KEY_PATH` | The certificate (and RSA key) registered on the app: `private_key_jwt`, never a secret |
| `SLAYZONE_HUB_SSO_REQUIRE_MFA` | `1` (default): the ID token's `amr` must contain `mfa` |

Redirect URI: `https://<public address>/api/auth/callback/microsoft`.

### Generic OpenID Connect provider

| Variable | Meaning |
| --- | --- |
| `SLAYZONE_HUB_OIDC_ISSUER` | The issuer's https URL, exactly as its tokens' `iss`. Endpoints come from `<issuer>/.well-known/openid-configuration` (fetched on first use, must name the same issuer). |
| `SLAYZONE_HUB_OIDC_CLIENT_ID` | The client id |
| `SLAYZONE_HUB_OIDC_CLIENT_SECRET` | `client_secret_basic` (env only). **Or** the certificate pair above (`private_key_jwt`, RS256 — PS256 when the issuer only lists that — with `kid` = `x5t#S256` = the certificate's SHA-256 thumbprint). Exactly one. |
| `SLAYZONE_HUB_OIDC_SCOPES` | Optional, space-separated, must include `openid`. Default `openid profile email offline_access` (a refresh token is needed by the IdP-role mode). |
| `SLAYZONE_HUB_SSO_REQUIRE_MFA` | As above. Many providers do not send `amr: ["mfa"]` (Keycloak by default): enforce MFA at the provider and set `0`. |

Redirect URI: `https://<public address>/api/auth/callback/oidc`. Accounts are keyed on
`<issuer>|<sub>` and never linked by email.

Clients name the sign-in from `/health` `ssoLabel`: "Sign in with Microsoft" for the
Entra setup, "Sign in with SSO" for a generic provider (web shell, desktop Settings, iOS
app, `slay hub login`, the device page). A client talking to an older hub, which reports
no label, says "Microsoft" — those hubs only had Entra sign-in.

### Migrating Entra from the tenant settings to the generic ones

`SLAYZONE_HUB_OIDC_ISSUER=https://login.microsoftonline.com/<tenant id>/v2.0` with
`SLAYZONE_HUB_OIDC_CLIENT_ID` and the same certificate is read as the Entra setup: same
provider id (`microsoft`), same callback URL, same account keys — no account is lost.
Unset `SLAYZONE_HUB_SSO_TENANT_ID` / `_CLIENT_ID` (both at once refuse boot). An Entra
issuer with a client secret refuses boot.

### Roles with the IdP-role mode off (default): unchanged

- **Entra setup**: exactly as before — `SlayZone.User` or `SlayZone.Admin` is required to
  sign in, `admin` exactly with `SlayZone.Admin`, written at every sign-in and by the
  hourly re-check; role changes in the hub answer 409 `SSO_MANAGED_ROLE`.
- **Generic provider** (new): the role claim is not read; roles are managed in the hub
  (`slay hub users role`). The first account on a hub with no enabled admin is admin, as
  for the first `slay hub users add`. Who may sign in at all is the provider's decision.

## 2. The IdP-role mode

### Settings (the shared contract's names)

| Variable | Default | Meaning |
| --- | --- | --- |
| `IDP_ROLES_ENABLED` | `false` | `true` turns the mode on. Exactly `true`/`false`. |
| `IDP_ROLE_CLAIM` | — (required when on) | The claim holding the roles. An exact claim name first (a SAML-style URI works), else a dotted path into nested claims (`realm_access.roles`). |
| `IDP_ROLE_MAPPING` | — (required when on) | JSON object: claim value → array of hub roles (`admin`, `user`). Values are case-sensitive. |
| `IDP_RECHECK_INTERVAL_SECONDS` | `3600` | How long role evidence counts, 1–3600. |

**Naming exception.** These four are unprefixed on purpose: every service of the
contract reads the same names with the same values. It is the only exception to the
`SLAYZONE_` prefix and `0|1` rules (CLAUDE.md, Env Var Naming); every other hub switch
keeps them. They are hub-only: stripped from every task terminal and agent
(`env-manifest.ts` `NON_PREFIXED_INFRA`) and cleared by a parent spawning a hub.

**Boot (B20)** refuses: a malformed value (also with the mode off), an empty mapping, an
unknown target role, the mode on without SSO, the mode on with
`SLAYZONE_HUB_ENABLE_PASSWORD` not `0`, and any retired name — including the
`SLAYZONE_HUB_SSO_ENABLE_ROLE_CLAIM` / `_ROLE_CLAIM` / `_ROLE_MAP` / `_ROLE_UNMAPPED`
names of an earlier draft (never released) and the other services' old names.

### What it does

- **Sign-in**: the verified ID token's claim is mapped; the highest role wins (`admin`
  over `user`). No mapped value, a malformed claim or no claim → refused, and every human
  credential of that identity is revoked (below). There is no fallback role and no
  automatic admin promotion: the hub has no admin until someone signs in holding a value
  that maps to `admin`. Recovery is server administration (`slayzone-hub break-glass` on
  the hub machine).
- **Denials are ordered like grants**: an unmapped sign-in's verified token carries its
  signed `iat`; it revokes only if that evidence is fresh, from a later second than the
  activation and the last revocation, and not older than the stored evidence (same
  second: revoked, fail closed). A delayed older unmapped callback is refused itself but
  revokes nothing.
- **Evidence time** is the ID token's signed `iat`, never the receipt time. Evidence only
  moves forward: a sign-in signed before the stored evidence is refused. It must also be
  signed in a **later second** than the current activation and the account's last
  revocation, so a login or code still pending at either moment never completes. Same-
  second evidence is refused (conservative seconds-vs-milliseconds handling): someone
  signing in within one second of an activation or a revocation signs in again a second
  later.
- **Freshness**: every human authenticated entry checks, from storage, that the evidence
  is younger than the interval; at the deadline the shared `revalidateOidc` runs inline —
  a refresh at the issuer, a new ID token verified (signature, issuer, audience, tenant,
  same account), re-mapped. No new ID token, a refresh failure (outage included), a
  missing or unmapped claim, older or same evidence, another subject, a failed save → the
  request is refused and the account loses its access until a fresh SSO sign-in. A sweep
  every minute refreshes signed-in accounts five minutes ahead so the inline path is
  rare; it never authorizes anything itself.
- **Entry points gated**: REST bearers and cookies (`verifySession`: REST, `/trpc`, CLI,
  desktop, iOS app tokens), web sessions (`resolveWebSession`), the browser-session reads
  that mint web, device and app credentials (`sso-page.ts`), the task CLI relay's owner
  (`cli-relay.ts`), open `/trpc` sockets (closed synchronously at the deadline unless the
  deadline already moved forward; subscriptions with them), direct-link grants (each
  carries the deadline as an absolute `notAfter` the computer enforces whatever the
  delivery delay, closing the direct connection then; a grant arriving past it is
  refused, an acknowledgement arriving past it is undone; a computer that does not
  advertise `directNotAfter` — an older release — gets no direct link while a deadline
  applies and its clients use the hub relay).
- **Issuance binding**: a session that is not itself an SSO sign-in (device token, app
  code) is minted only if the SSO authentication that approved it happened under the
  account's current grant. A code approved before a revocation or activation never mints
  a session — also after the person signs in again.
- **Revocation** (no mapped role, or no fresh evidence) ends, for that account: its
  better-auth sessions (cookies, CLI/desktop/app bearers), its user API keys, its web
  sessions, its open sockets and its direct-link grants; its role becomes `user` and
  access stays withdrawn until a new verified sign-in. Sessions created before that sign-
  in stay dead even if a row survived. **Not revoked (automation)**: computer API keys
  (owned by the service user), join tokens, the computers themselves.
- **Activation**: turning the mode on, or changing the issuer, client, claim, mapping or
  interval, starts a new epoch persisted in hub-auth's database, in the same transaction
  as: ending every human session, deleting human API keys, clearing every human's role
  and evidence, and deleting pending OAuth state and device codes. The hub then revokes
  web sessions before it serves. Restarting with the same config does nothing; turning
  the mode off is recorded, so off → on is a new epoch. Every request is also fenced
  against the persisted state: a process still running an older config — or the mode
  off — while the database says otherwise authorizes nobody.
- **Local role changes** (`slay hub users role`, `PATCH /api/hub/users`, `add` with a
  role) answer **409 `ROLES_MANAGED_BY_IDP`**, "Roles are managed by your identity
  provider." There is no UI path for role changes. Disable/enable still work.
- **Concurrency**: one refresh per identity at a time (a hub is one process: an in-
  process lock covering the refresh request and the save); every save is a compare-and-
  set on (revision, stored refresh token, epoch). A sign-in landing during a refresh
  wins; the stale refresh fails closed for its own request without revoking anything.

### Audit (security log, stdout `"type":"security"`)

The contract's events, `detail` = `{ event, service: "slayzone", actor, subject, source,
previousGrants, newGrants, reason }` (opaque ids, static reasons, no tokens or emails):
`idp_roles.granted` (sign-in), `idp_roles.revalidated`, `idp_roles.denied` (reasons
`no_mapped_role`, `missing_id_token`, `refresh_failed`, `stale_evidence`,
`verification_failed`, `refresh_unavailable`, `superseded_evidence`,
`pre_cutoff_evidence`, `stale_authorization`, `unbound_issuance`, …),
`idp_roles.local_change_refused`, `idp_roles.activation` (one per invalidated human). A
role change is also `user.role_change`; a refused sign-in also `auth.signin` denied.

### Example: Microsoft Entra ID

1. App registration → **App roles**: `SlayZone.Admin` and `SlayZone.User` (allowed member
   types Users/Groups). Entra puts assigned app roles in the ID token's `roles` claim.
2. Enterprise application → **Assignment required** = Yes; assign people or groups.
3. Hub environment (with the Entra settings of section 1):

   ```sh
   SLAYZONE_HUB_ENABLE_PASSWORD=0
   IDP_ROLES_ENABLED=true
   IDP_ROLE_CLAIM=roles
   IDP_ROLE_MAPPING={"SlayZone.Admin":["admin"],"SlayZone.User":["user"]}
   IDP_RECHECK_INTERVAL_SECONDS=3600
   ```

   This mapping reproduces the mode-off Entra rule, now with freshness, revocation and
   the shared contract's behaviour.

### Other providers

| Provider | `IDP_ROLE_CLAIM` | Mapping example |
| --- | --- | --- |
| Okta | `groups` (add a Groups claim to the ID token) | `{"hub-admins":["admin"],"hub-users":["user"]}` |
| Keycloak | `realm_access.roles` | `{"hub-admin":["admin"],"hub-user":["user"]}` |
| SAML-style attribute names | the full URI | as above |
| Google | Google ID tokens carry no roles or groups: use a provider in front | — |

The provider must return a new ID token, with the role claim, on every refresh; one that
does not makes people sign in again every interval.

### Rollout (coordinated across services; no live change made by this work)

- Mode off is the default and changes nothing for existing hubs.
- Before turning it on: assign roles at the provider, set `SLAYZONE_HUB_ENABLE_PASSWORD=0`,
  make sure at least one person holds a value mapping to `admin`, keep host clocks
  synchronised (evidence deadlines have no skew allowance).
- The first boot with the mode on signs every person out once; they sign in again
  through SSO. Changing the mapping, claim, interval, issuer or client does the same.
- Run one hub process per database. A second process with a different view of the mode
  fails closed rather than authorizing.

### Known limitations

- `/health` keeps the field name `appSignIn.microsoft` (older clients read it): it means
  "the app sign-in is served", whatever the provider.
- The refresh lock is per process (a hub is one node); the storage CAS still fails closed
  across processes.
- SAML sign-in is not part of the hub (Cloudable's adapter covers SAML).
