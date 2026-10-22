/**
 * Entra ID sign-in (T-09): single tenant, authorization code + PKCE, the hub proving
 * itself with a CERTIFICATE, and the hub's own checks on every ID token.
 *
 * WHAT BETTER-AUTH DOES AND WHAT THIS MODULE DOES. better-auth runs the flow:
 * `POST /api/auth/sign-in/social` (state cookie + PKCE verifier, returns the authorize
 * URL), `GET /api/auth/callback/microsoft` (state check, user + account rows, session).
 * The provider object better-auth calls in between is replaced wholesale here, because
 * its built-in `microsoft` provider cannot do what this hub needs:
 *   - it authenticates to the token endpoint with a client SECRET only — the hub uses a
 *     signed client assertion (`private_key_jwt`, O-18), so the code exchange and the
 *     refresh are ours ({@link signClientAssertion});
 *   - it verifies the ID token only on the ID-token sign-in route, NOT in the callback:
 *     there it decodes the token unverified and keys the account on `sub`. Here the ID
 *     token is verified (signature against the tenant's keys, audience, issuer, `tid`)
 *     before anything is read from it, and the account is keyed on `oid` + `tid`;
 *   - it reads no `roles` and no `amr`, and fetches a profile photo from Graph on every
 *     sign-in.
 * The provider keeps better-auth's id `microsoft` (the sign-in route accepts only known
 * ids), so the callback path is `/api/auth/callback/microsoft`.
 *
 * THE CHECKS (on the verified ID token, every sign-in — {@link evaluateEntraIdToken}):
 *   - `tid` and `iss` are the configured tenant              else `wrong_tenant`
 *   - `oid` present                                          else `no_oid`
 *   - `roles` holds {@link ENTRA_USER_ROLE} or {@link ENTRA_ADMIN_ROLE}  else `unassigned`
 *   - `amr` holds `mfa` (unless `requireMfa` is off)         else `no_mfa`
 *   - an email (`email`, else `preferred_username`)          else `no_email`
 * A refusal is one `auth.signin` denied line naming the reason, and the callback
 * redirects to the error URL with better-auth's generic `unable_to_get_user_info`.
 *
 * ROLE (O-4): `admin` exactly when `roles` holds {@link ENTRA_ADMIN_ROLE}, else `user`,
 * written at EVERY sign-in ({@link syncEntraRole}) — removing the app role in Entra
 * demotes the account at its next sign-in. On a hub with SSO on, nothing else sets a
 * role (users.ts refuses manual changes and skips the first-admin promotion).
 *
 * HOW THE CLAIMS REACH THE DATABASE HOOKS. The callback creates the user and the session
 * through better-auth's adapter, whose hooks only see the row. The verified verdict
 * travels in better-auth's request-scoped state ({@link entraSignIn}), set by the code
 * exchange and the ID-token check of THIS request, so a hook can never act on a
 * verdict from another request — and outside the callback there is none.
 *
 * Never logged: the private key (a `KeyObject`, which prints as `KeyObject {}`), the
 * client assertion, any token, the email.
 *
 * @module hub-auth/entra
 */
import {
  constants,
  createHash,
  createHmac,
  createPrivateKey,
  type KeyObject,
  randomUUID,
  sign,
  X509Certificate
} from 'node:crypto'
import { readFileSync } from 'node:fs'
import { defineRequestState, hasRequestState } from '@better-auth/core/context'
import { securityEvent } from '@slayzone/platform/security-log'
import type { AuthContext, BetterAuthPlugin, GenericEndpointContext } from 'better-auth'
import {
  createAuthorizationURL,
  getOAuth2Tokens,
  type OAuth2Tokens,
  type OAuthProvider
} from 'better-auth/oauth2'
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose'
import type { HubRole } from '../shared/types'
import { readRole } from './account'

/** better-auth's provider id. The sign-in route only accepts ids it knows. */
export const ENTRA_PROVIDER_ID = 'microsoft'

/** Id of the plugin that installs the provider — also how a hub is recognised as SSO. */
export const ENTRA_PLUGIN_ID = 'slayzone-entra-sso'

/** App role that makes an account `admin` (O-4). */
export const ENTRA_ADMIN_ROLE = 'SlayZone.Admin'

/** App role every other permitted person is assigned. Holding neither role = refused. */
export const ENTRA_USER_ROLE = 'SlayZone.User'

/** Microsoft's login authority. */
export const ENTRA_AUTHORITY = 'https://login.microsoftonline.com'

/**
 * Scopes requested. `offline_access` for the refresh token kept on the account row
 * (O-8, read by the hourly re-check of T-12); no Graph scope, nothing reads Graph.
 */
export const ENTRA_SCOPES: readonly string[] = ['openid', 'profile', 'email', 'offline_access']

const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'

/** Lifetime of one client assertion. Microsoft: "5-10 minutes after nbf at most". */
const ASSERTION_TTL_SEC = 300

/** Clock skew accepted on ID tokens (the tolerance Microsoft's own libraries use). */
const CLOCK_TOLERANCE_SEC = 300

/** The hub's client credential, loaded once at boot. */
export interface EntraClientCredential {
  /** RSA private key the assertions are signed with. */
  readonly privateKey: KeyObject
  /** base64url SHA-256 of the certificate's DER: the assertion's `x5t#S256` header. */
  readonly thumbprintS256: string
}

export interface EntraSsoConfig {
  /** Directory (tenant) id, a GUID. */
  tenantId: string
  /** Application (client) id, a GUID. */
  clientId: string
  credential: EntraClientCredential
  /** Refuse an ID token whose `amr` lacks `mfa` (`SLAYZONE_HUB_SSO_REQUIRE_MFA`). */
  requireMfa: boolean
  /**
   * Login authority, default {@link ENTRA_AUTHORITY}. Tests point it at a local fake
   * issuer; it is deliberately not an env setting, so no configuration can send the
   * code and the client assertion anywhere but Microsoft.
   */
  authority?: string
}

// ---------------------------------------------------------------------------
// Credential
// ---------------------------------------------------------------------------

const CERT_PEM = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/
const KEY_PEM = /-----BEGIN ((?:RSA |ENCRYPTED )?PRIVATE KEY)-----[\s\S]+?-----END \1-----/

/** An fs error's code (`ENOENT`, `EACCES`), never its message. */
const fsCode = (err: unknown): string => (err as NodeJS.ErrnoException | null)?.code ?? 'unreadable'

/**
 * Read the certificate and its private key from PEM files (one file holding both may
 * be passed twice). Checks that the key is an unencrypted RSA key and BELONGS to the
 * certificate, so a mismatch refuses the boot instead of failing every sign-in.
 *
 * Error messages name paths and reasons only — never file contents, and never an
 * OpenSSL message (which could quote input).
 */
export function loadEntraClientCredential(paths: {
  certPath: string
  keyPath: string
}): EntraClientCredential {
  const read = (path: string, what: string): string => {
    try {
      return readFileSync(path, 'utf8')
    } catch (err) {
      throw new Error(`cannot read the ${what} at ${path} (${fsCode(err)})`)
    }
  }
  const certBlock = CERT_PEM.exec(read(paths.certPath, 'certificate'))?.[0]
  if (!certBlock) throw new Error(`${paths.certPath} holds no PEM certificate`)
  let cert: X509Certificate
  try {
    cert = new X509Certificate(certBlock)
  } catch {
    throw new Error(`the certificate in ${paths.certPath} does not parse`)
  }

  const keyMatch = KEY_PEM.exec(read(paths.keyPath, 'private key'))
  if (!keyMatch) throw new Error(`${paths.keyPath} holds no PEM private key`)
  if (keyMatch[1] === 'ENCRYPTED PRIVATE KEY') {
    throw new Error(
      `the private key in ${paths.keyPath} is encrypted; give the hub an unencrypted key`
    )
  }
  let privateKey: KeyObject
  try {
    privateKey = createPrivateKey(keyMatch[0])
  } catch {
    throw new Error(`the private key in ${paths.keyPath} does not parse`)
  }
  if (privateKey.asymmetricKeyType !== 'rsa') {
    throw new Error(
      `the private key in ${paths.keyPath} is ${privateKey.asymmetricKeyType ?? 'not asymmetric'}; ` +
        `Entra client assertions are PS256, which needs an RSA key`
    )
  }
  if (!cert.checkPrivateKey(privateKey)) {
    throw new Error(
      `the private key in ${paths.keyPath} does not belong to the certificate in ${paths.certPath}`
    )
  }
  return Object.freeze({
    privateKey,
    thumbprintS256: createHash('sha256').update(cert.raw).digest('base64url')
  })
}

const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')

/**
 * A client assertion for one token request, in the shape Microsoft documents for
 * certificate credentials: PS256, `x5t#S256`, `aud` = the token endpoint, `iss` = `sub`
 * = the client id, a fresh `jti`, five minutes to live.
 */
export function signClientAssertion(
  cfg: Pick<EntraSsoConfig, 'clientId' | 'credential'>,
  audience: string,
  nowMs: number = Date.now()
): string {
  const now = Math.floor(nowMs / 1000)
  const header = { alg: 'PS256', typ: 'JWT', 'x5t#S256': cfg.credential.thumbprintS256 }
  const payload = {
    aud: audience,
    iss: cfg.clientId,
    sub: cfg.clientId,
    jti: randomUUID(),
    iat: now,
    nbf: now,
    exp: now + ASSERTION_TTL_SEC
  }
  const input = `${b64url(header)}.${b64url(payload)}`
  const signature = sign('sha256', Buffer.from(input), {
    key: cfg.credential.privateKey,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST
  })
  return `${input}.${signature.toString('base64url')}`
}

// ---------------------------------------------------------------------------
// ID token
// ---------------------------------------------------------------------------

/** Why a sign-in was refused by the checks above. Values are audit reason codes. */
export type EntraRefusal =
  | 'invalid_token'
  | 'wrong_tenant'
  | 'no_oid'
  | 'unassigned'
  | 'no_mfa'
  | 'no_email'

export type EntraVerdict =
  | {
      ok: true
      /** The `account.accountId`: `<oid>.<tid>` (MSAL's home-account-id shape). */
      accountId: string
      email: string
      name: string
      role: HubRole
    }
  | { ok: false; reason: EntraRefusal; accountId: string | null }

/** `<oid>.<tid>` — the identity key on the better-auth `account` row. */
export function entraAccountId(oid: string, tid: string): string {
  return `${oid.toLowerCase()}.${tid.toLowerCase()}`
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

type KeyResolver = Parameters<typeof jwtVerify>[1]

const authorityOf = (cfg: EntraSsoConfig): string =>
  (cfg.authority ?? ENTRA_AUTHORITY).replace(/\/+$/, '')

/** The issuer every ID token of this tenant carries (v2.0 endpoint). */
export const entraIssuer = (cfg: EntraSsoConfig): string =>
  `${authorityOf(cfg)}/${cfg.tenantId.toLowerCase()}/v2.0`

const tokenEndpoint = (cfg: EntraSsoConfig): string =>
  `${authorityOf(cfg)}/${cfg.tenantId.toLowerCase()}/oauth2/v2.0/token`

/**
 * Verify an ID token and apply the hub's checks. The signature, audience and lifetime
 * are verified FIRST (against the tenant's published keys — Entra signs every tenant
 * with the same keys, so a foreign tenant's token verifies and is then refused on its
 * `tid`); nothing is read from an unverified token.
 */
export async function evaluateEntraIdToken(
  cfg: EntraSsoConfig,
  idToken: string,
  keys: KeyResolver
): Promise<EntraVerdict> {
  let claims: JWTPayload
  try {
    ;({ payload: claims } = await jwtVerify(idToken, keys, {
      audience: cfg.clientId,
      algorithms: ['RS256'],
      clockTolerance: CLOCK_TOLERANCE_SEC
    }))
  } catch {
    return { ok: false, reason: 'invalid_token', accountId: null }
  }
  const tid = str(claims.tid)?.toLowerCase() ?? null
  const oid = str(claims.oid)?.toLowerCase() ?? null
  const accountId = tid && oid ? entraAccountId(oid, tid) : null
  const refuse = (reason: EntraRefusal): EntraVerdict => ({ ok: false, reason, accountId })

  if (tid !== cfg.tenantId.toLowerCase() || claims.iss !== entraIssuer(cfg)) {
    return { ok: false, reason: 'wrong_tenant', accountId: null }
  }
  if (!oid || !accountId) return refuse('no_oid')
  const roles = strings(claims.roles)
  if (!roles.includes(ENTRA_USER_ROLE) && !roles.includes(ENTRA_ADMIN_ROLE)) {
    return refuse('unassigned')
  }
  if (cfg.requireMfa && !strings(claims.amr).includes('mfa')) return refuse('no_mfa')
  const email = (str(claims.email) ?? str(claims.preferred_username))?.toLowerCase()
  if (!email) return refuse('no_email')
  return {
    ok: true,
    accountId,
    email,
    name: str(claims.name) ?? email,
    role: roles.includes(ENTRA_ADMIN_ROLE) ? 'admin' : 'user'
  }
}

// ---------------------------------------------------------------------------
// Request-scoped verdict
// ---------------------------------------------------------------------------

/** What this request's sign-in established so far. */
export interface EntraSignIn {
  /** The ID token this request's code exchange returned. */
  idToken: string | null
  verdict: EntraVerdict | null
}

const entraSignInState = defineRequestState<EntraSignIn | null>(() => null)

/** This request's Entra sign-in, or null (no request, or not an Entra callback). */
export async function entraSignIn(): Promise<EntraSignIn | null> {
  return (await hasRequestState()) ? entraSignInState.get() : null
}

/** This request's verdict when it PASSED the checks, else null. */
async function passedVerdict(): Promise<Extract<EntraVerdict, { ok: true }> | null> {
  const verdict = (await entraSignIn())?.verdict
  return verdict?.ok ? verdict : null
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

/** One POST to the token endpoint, authenticated with a fresh client assertion. */
async function tokenRequest(
  cfg: EntraSsoConfig,
  params: Record<string, string>
): Promise<OAuth2Tokens> {
  const endpoint = tokenEndpoint(cfg)
  const body = new URLSearchParams({
    ...params,
    client_id: cfg.clientId,
    client_assertion_type: JWT_BEARER,
    client_assertion: signClientAssertion(cfg, endpoint)
  })
  // `manual`: the code and the assertion go to exactly one place, never on to
  // wherever a redirect points.
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    redirect: 'manual'
  })
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok || !data) {
    // Only the error code and Entra's AADSTS number reach the log (better-auth logs
    // this error): never the request, which carries the code and the assertion.
    const code = str(data?.error) ?? 'no_body'
    const aadsts = /AADSTS\d+/.exec(String(data?.error_description ?? ''))?.[0]
    throw new Error(
      `[hub-auth] Entra token endpoint answered ${res.status} (${code}${aadsts ? `, ${aadsts}` : ''})`
    )
  }
  return getOAuth2Tokens(data)
}

// ---------------------------------------------------------------------------
// Provider + plugin
// ---------------------------------------------------------------------------

/** The provider better-auth calls; see the module note for why it is not better-auth's. */
function entraProvider(
  cfg: EntraSsoConfig,
  keys: KeyResolver,
  getContext: () => AuthContext | null
): OAuthProvider {
  const authorizationEndpoint = `${authorityOf(cfg)}/${cfg.tenantId.toLowerCase()}/oauth2/v2.0/authorize`
  return {
    id: ENTRA_PROVIDER_ID,
    name: 'Microsoft Entra ID',
    // Scopes are fixed: `c.body.scopes` from the sign-in request is not honoured, so
    // a client cannot widen what the hub asks Entra for.
    createAuthorizationURL: ({ state, codeVerifier, redirectURI, loginHint }) =>
      createAuthorizationURL({
        id: ENTRA_PROVIDER_ID,
        options: { clientId: cfg.clientId },
        authorizationEndpoint,
        state,
        codeVerifier,
        scopes: [...ENTRA_SCOPES],
        redirectURI,
        loginHint
      }),
    async validateAuthorizationCode({ code, codeVerifier, redirectURI }) {
      // PKCE is not optional: better-auth always sends a verifier, so its absence
      // means something else called this.
      if (!codeVerifier) throw new Error('[hub-auth] Entra code exchange without a PKCE verifier')
      const tokens = await tokenRequest(cfg, {
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectURI,
        scope: ENTRA_SCOPES.join(' ')
      })
      // Mark THIS request as an Entra sign-in carrying exactly this ID token.
      if (await hasRequestState()) {
        await entraSignInState.set({ idToken: tokens.idToken ?? null, verdict: null })
      }
      return tokens
    },
    // better-auth's `/refresh-token` and `/get-access-token` (and the re-check of T-12)
    // land here: same client assertion, no secret.
    refreshAccessToken: (refreshToken) =>
      tokenRequest(cfg, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: ENTRA_SCOPES.join(' ')
      }),
    // No ID-token sign-in: a client handing the hub a token it obtained elsewhere is
    // refused. Only the code flow this hub runs itself signs anyone in.
    verifyIdToken: async () => false,
    async getUserInfo(tokens) {
      // Only inside the callback whose code exchange produced this very token.
      // Anything else that asks (better-auth's account-info route) gets nothing.
      const signIn = await entraSignIn()
      if (!signIn || !tokens.idToken || tokens.idToken !== signIn.idToken) return null
      const verdict = await evaluateEntraIdToken(cfg, tokens.idToken, keys)
      signIn.verdict = verdict
      if (!verdict.ok) {
        await auditRefusal(verdict, getContext())
        return null
      }
      return {
        user: {
          id: verdict.accountId,
          email: verdict.email,
          name: verdict.name,
          emailVerified: false
        },
        data: {}
      }
    },
    // New accounts are created on first sign-in (who may sign in is decided by the
    // checks above, not by an operator pre-creating rows); profile fields are not
    // rewritten on later sign-ins.
    disableSignUp: false,
    options: { clientId: cfg.clientId, overrideUserInfoOnSignIn: false }
  }
}

/** One `auth.signin` denied line for a refused ID token. Names the account when one
 *  exists; otherwise a keyed hash of the Entra identity so repeats correlate. */
async function auditRefusal(
  verdict: Extract<EntraVerdict, { ok: false }>,
  ctx: AuthContext | null
): Promise<void> {
  try {
    let userId: string | null = null
    if (verdict.accountId && ctx) {
      const account = await ctx.internalAdapter.findAccountByProviderId(
        verdict.accountId,
        ENTRA_PROVIDER_ID
      )
      userId = account?.userId ?? null
    }
    securityEvent({
      event: 'auth.signin',
      outcome: 'denied',
      actor: null,
      targetKind: userId ? 'user' : null,
      targetId: userId,
      detail: {
        method: 'sso',
        reason: verdict.reason,
        subjectRef:
          verdict.accountId && ctx
            ? createHmac('sha256', ctx.secret).update(verdict.accountId).digest('hex').slice(0, 16)
            : null
      }
    })
  } catch {
    // An audit line must never fail the refusal it reports.
  }
}

/**
 * The plugin that installs the Entra provider. Its presence on an instance is what
 * makes a hub an "SSO hub" ({@link isEntraSsoAuth}).
 */
export function entraSso(cfg: EntraSsoConfig) {
  // One key set per instance: jose caches the tenant's keys and refetches on an
  // unknown `kid` (Entra rotates its signing keys).
  const keys = createRemoteJWKSet(
    new URL(`${authorityOf(cfg)}/${cfg.tenantId.toLowerCase()}/discovery/v2.0/keys`)
  )
  let context: AuthContext | null = null
  return {
    id: ENTRA_PLUGIN_ID,
    init(ctx) {
      context = ctx
      return {
        context: {
          socialProviders: [
            entraProvider(cfg, keys, () => context),
            ...ctx.socialProviders.filter((p) => p.id !== ENTRA_PROVIDER_ID)
          ]
        }
      }
    }
  } satisfies BetterAuthPlugin
}

/** True for an instance built with Entra sign-in. */
export function isEntraSsoAuth(auth: { options: { plugins?: ReadonlyArray<{ id: string }> } }) {
  return auth.options.plugins?.some((p) => p.id === ENTRA_PLUGIN_ID) === true
}

// ---------------------------------------------------------------------------
// Database hooks (wired in auth.ts)
// ---------------------------------------------------------------------------

/** `databaseHooks.user.create.before`: an account created by an Entra sign-in starts
 *  with the role its token carries. */
export async function entraUserCreateBefore(
  user: Record<string, unknown>
): Promise<{ data: Record<string, unknown> } | undefined> {
  const verdict = await passedVerdict()
  return verdict ? { data: { ...user, role: verdict.role } } : undefined
}

/** `databaseHooks.user.create.after`: the `user.create` line for an account an Entra
 *  sign-in created (operator-created accounts write theirs in users.ts). */
export async function entraUserCreateAfter(user: { id?: unknown; role?: unknown }): Promise<void> {
  if (!(await passedVerdict())) return
  securityEvent({
    event: 'user.create',
    outcome: 'success',
    actor: null,
    targetKind: 'user',
    targetId: typeof user.id === 'string' ? user.id : null,
    detail: { method: 'sso', role: readRole(user.role) }
  })
}

/**
 * `databaseHooks.session.create.before`, after the disabled-account guard: the session
 * an Entra sign-in creates first sets the account's role from the token (O-4). Fails
 * CLOSED if the session is not for the account the token names.
 */
export async function syncEntraRole(
  session: { userId?: unknown },
  ctx: GenericEndpointContext | null
): Promise<void> {
  const verdict = await passedVerdict()
  if (!verdict) return
  const adapter = ctx?.context.internalAdapter
  if (!adapter) throw new Error('[hub-auth] Entra sign-in without an auth context')
  const account = await adapter.findAccountByProviderId(verdict.accountId, ENTRA_PROVIDER_ID)
  if (!account || account.userId !== session.userId) {
    throw new Error('[hub-auth] Entra sign-in session does not match the signed-in identity')
  }
  const user = (await adapter.findUserById(account.userId)) as Record<string, unknown> | null
  if (!user || readRole(user.role) === verdict.role) return
  await adapter.updateUser(account.userId, { role: verdict.role })
  securityEvent({
    event: 'user.role_change',
    outcome: 'success',
    actor: null,
    targetKind: 'user',
    targetId: account.userId,
    detail: { reason: 'sso_claim', role: verdict.role }
  })
}
