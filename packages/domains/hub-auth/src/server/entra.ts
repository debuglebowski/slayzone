/**
 * SSO sign-in through OpenID Connect (T-09, generalised): authorization code + PKCE
 * against ONE issuer — Microsoft Entra ID through its tenant settings, or any OpenID
 * provider (Okta, Keycloak, Google, Auth0, Entra, …) through the generic settings —
 * with the hub's own checks on every ID token.
 *
 * TWO WAYS TO CONFIGURE IT ({@link SsoConfig}):
 *   - {@link EntraSsoConfig} — `SLAYZONE_HUB_SSO_TENANT_ID` + `_CLIENT_ID` + certificate.
 *     Unchanged since T-09: single tenant, the `tid` check, account key `<oid>.<tid>`,
 *     provider id `microsoft` (callback `/api/auth/callback/microsoft`).
 *   - {@link OidcSsoConfig} — `SLAYZONE_HUB_OIDC_ISSUER` + `_CLIENT_ID` + a certificate
 *     (`private_key_jwt`) or a client secret. Endpoints from the issuer's discovery
 *     document; account key `<issuer>|<sub>`; provider id `oidc`. An Entra issuer
 *     (`https://login.microsoftonline.com/<tenant>/v2.0`) is read as the Entra setup
 *     (same id, same account keys), so moving between the two loses no account.
 *
 * WHAT BETTER-AUTH DOES AND WHAT THIS MODULE DOES. better-auth runs the flow:
 * `POST /api/auth/sign-in/social` (state cookie + PKCE verifier, returns the authorize
 * URL), `GET /api/auth/callback/<id>` (state check, user + account rows, session). The
 * provider object it calls in between is ours: the code exchange and refresh
 * authenticate with a signed client assertion or a client secret, the ID token is
 * verified (signature against the issuer's keys, audience, issuer; Entra: `tid`)
 * before anything is read from it, and the account is keyed as above.
 *
 * THE CHECKS (on the verified ID token, every sign-in — {@link evaluateIdToken}):
 *   - issuer is the configured one (Entra: and `tid` its tenant)  else `wrong_tenant`
 *   - a subject (Entra: `oid`; else `sub`)                         else `no_oid`
 *   - the roles rule of the {@link RoleMode}                      else `unassigned` /
 *                                                                  `no_mapped_role`
 *   - `amr` holds `mfa` (unless `requireMfa` is off)               else `no_mfa`
 *   - an email (`email`, else `preferred_username`)                else `no_email`
 *   - IdP-role mode: a numeric `iat` young enough to be evidence   else `stale_evidence`
 * A refusal is one `auth.signin` denied line naming the reason, and the callback
 * redirects to the error URL with better-auth's generic `unable_to_get_user_info`.
 *
 * ROLES ({@link RoleMode}):
 *   - `entra-app-roles` — IdP-role mode OFF on the Entra setup: exactly the behaviour
 *     before the mode existed (O-4). `SlayZone.User` or `SlayZone.Admin` is required,
 *     `admin` exactly with `SlayZone.Admin`, written at every sign-in
 *     ({@link syncEntraRole}) and by the hourly re-check (./entra-recheck.ts).
 *   - `hub` — IdP-role mode OFF on a generic issuer: the claim is not read; the role is
 *     managed in the hub (the first account on a hub with no enabled admin is admin, as
 *     for `slay hub users add`).
 *   - `idp` — the IdP-role mode (`IDP_ROLES_ENABLED=true`, ./idp-roles.ts): grants from
 *     the shared contract (@normain/idp-role-contract `resolveGrants`), highest of
 *     admin/user, no mapped role refused — and any account of that identity loses its
 *     sessions and credentials. Persistence, freshness and revalidation: ./idp-roles.ts.
 *
 * HOW THE CLAIMS REACH THE DATABASE HOOKS. The callback creates the user and the session
 * through better-auth's adapter, whose hooks only see the row. The verified verdict
 * travels in better-auth's request-scoped state ({@link entraSignIn}), set by the code
 * exchange and the ID-token check of THIS request, so a hook can never act on a verdict
 * from another request — and outside the callback there is none.
 *
 * Never logged: the private key (a `KeyObject`, which prints as `KeyObject {}`), the
 * client secret, the client assertion, any token, the email.
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
import { freshness, type RoleConfig, resolveGrants } from '@normain/idp-role-contract'
import { securityEvent } from '@slayzone/platform/security-log'
import type { AuthContext, BetterAuthPlugin, GenericEndpointContext } from 'better-auth'
import {
  createAuthorizationURL,
  getOAuth2Tokens,
  type OAuth2Tokens,
  type OAuthProvider
} from 'better-auth/oauth2'
import {
  createRemoteJWKSet,
  customFetch,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify
} from 'jose'
import type { HubRole } from '../shared/types'
import { isBreakGlassEmail, readRole } from './account'
import { COMPUTER_SERVICE_USER_EMAIL } from './computer-keys'

/** better-auth's provider id for the Entra setup. The callback path and every Entra
 *  `account` row carry it, so it never changes. */
export const ENTRA_PROVIDER_ID = 'microsoft'

/** better-auth's provider id for a generic OpenID issuer (`/api/auth/callback/oidc`). */
export const OIDC_PROVIDER_ID = 'oidc'

/** Every provider id an SSO account row can carry. */
export const SSO_PROVIDER_IDS: readonly string[] = [ENTRA_PROVIDER_ID, OIDC_PROVIDER_ID]

/** Id of the plugin that installs the provider — also how a hub is recognised as SSO. */
export const ENTRA_PLUGIN_ID = 'slayzone-entra-sso'

/** App role the IdP-role mode OFF on the Entra setup reads as `admin` (O-4). */
export const ENTRA_ADMIN_ROLE = 'SlayZone.Admin'

/** App role every other permitted person holds there. Holding neither = refused. */
export const ENTRA_USER_ROLE = 'SlayZone.User'

/** Microsoft's login authority. */
export const ENTRA_AUTHORITY = 'https://login.microsoftonline.com'

/**
 * Scopes requested by default. `offline_access` for the refresh token kept on the
 * account row (O-8, the re-check of T-12 and the IdP-role revalidation); no Graph scope.
 */
export const ENTRA_SCOPES: readonly string[] = ['openid', 'profile', 'email', 'offline_access']

const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'

/** Lifetime of one client assertion. Microsoft: "5-10 minutes after nbf at most". */
const ASSERTION_TTL_SEC = 300

/** Clock skew accepted on ID token `exp`/`nbf` (the tolerance Microsoft's libraries use). */
const CLOCK_TOLERANCE_SEC = 300

/** ID-token algorithms a generic issuer may sign with: asymmetric only. */
const GENERIC_ID_TOKEN_ALGS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA'
]

/** An Entra v2.0 issuer: read as the Entra setup ({@link ssoProvider}). */
const ENTRA_ISSUER =
  /^https:\/\/login\.microsoftonline\.com\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/v2\.0$/i

/** The hub's client credential, loaded once at boot. */
export interface EntraClientCredential {
  /** RSA private key the assertions are signed with. */
  readonly privateKey: KeyObject
  /** base64url SHA-256 of the certificate's DER: the assertion's `x5t#S256` header. */
  readonly thumbprintS256: string
}

/** How the hub authenticates to the token endpoint. */
export type OidcClientAuth =
  | { method: 'private_key_jwt'; credential: EntraClientCredential }
  | { method: 'client_secret_basic'; secret: string }

/** The Entra setup (tenant settings). */
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
  /** The IdP-role mode (./idp-roles.ts). Absent, or `enabled: false`: off. */
  idpRoles?: RoleConfig | null
  /** Test seam: token endpoint and key set. */
  fetch?: EntraFetch
}

/** A generic OpenID issuer. */
export interface OidcSsoConfig {
  /** Exactly the `iss` its tokens carry; discovery at `<issuer>/.well-known/openid-configuration`. */
  issuer: string
  clientId: string
  clientAuth: OidcClientAuth
  /** Refuse an ID token whose `amr` lacks `mfa`. */
  requireMfa: boolean
  /** Default {@link ENTRA_SCOPES}. Must contain `openid`. */
  scopes?: readonly string[]
  idpRoles?: RoleConfig | null
  /** Test seam: discovery, token endpoint and key set. */
  fetch?: EntraFetch
}

export type SsoConfig = EntraSsoConfig | OidcSsoConfig

/** Which rule sets an SSO account's role (see the module note). */
export type RoleMode = 'entra-app-roles' | 'hub' | 'idp'

interface Endpoints {
  authorization: string
  token: string
  jwks: string
  /** `token_endpoint_auth_signing_alg_values_supported` from discovery, when given. */
  assertionAlgs?: readonly string[]
}

/** One configured issuer, resolved ({@link ssoProvider}). */
export interface SsoProvider {
  readonly providerId: string
  readonly issuer: string
  readonly clientId: string
  readonly clientAuth: OidcClientAuth
  readonly requireMfa: boolean
  readonly scopes: readonly string[]
  /** Entra: the tenant every token's `tid` must name. Generic: null. */
  readonly entraTenantId: string | null
  readonly roleMode: RoleMode
  /** The IdP-role mode's config when {@link roleMode} is `idp`, else null. */
  readonly idpRoles: RoleConfig | null
  readonly idTokenAlgs: readonly string[]
  readonly fetch: EntraFetch
  endpoints(): Promise<Endpoints>
  /** The `account.accountId` of a verified token's claims, or null without a subject. */
  accountIdOf(claims: JWTPayload): string | null
}

const isEntraConfig = (cfg: SsoConfig): cfg is EntraSsoConfig => 'tenantId' in cfg

const resolved = new WeakMap<SsoConfig, SsoProvider>()

/** Resolve a config once (cached per config object: one key set, one discovery). */
export function ssoProvider(cfg: SsoConfig): SsoProvider {
  const hit = resolved.get(cfg)
  if (hit) return hit
  const provider = isEntraConfig(cfg) ? entraSetup(cfg) : genericSetup(cfg)
  resolved.set(cfg, provider)
  return provider
}

const roleModeOf = (idpRoles: RoleConfig | null | undefined, legacy: RoleMode): RoleMode =>
  idpRoles?.enabled ? 'idp' : legacy

function entraSetup(cfg: EntraSsoConfig): SsoProvider {
  const authority = (cfg.authority ?? ENTRA_AUTHORITY).replace(/\/+$/, '')
  const tenant = cfg.tenantId.toLowerCase()
  const roleMode = roleModeOf(cfg.idpRoles, 'entra-app-roles')
  const endpoints: Endpoints = {
    authorization: `${authority}/${tenant}/oauth2/v2.0/authorize`,
    token: `${authority}/${tenant}/oauth2/v2.0/token`,
    jwks: `${authority}/${tenant}/discovery/v2.0/keys`,
    assertionAlgs: ['PS256']
  }
  return {
    providerId: ENTRA_PROVIDER_ID,
    issuer: `${authority}/${tenant}/v2.0`,
    clientId: cfg.clientId,
    clientAuth: { method: 'private_key_jwt', credential: cfg.credential },
    requireMfa: cfg.requireMfa,
    scopes: ENTRA_SCOPES,
    entraTenantId: tenant,
    roleMode,
    idpRoles: roleMode === 'idp' ? (cfg.idpRoles ?? null) : null,
    idTokenAlgs: ['RS256'],
    fetch: cfg.fetch ?? fetch,
    endpoints: async () => endpoints,
    accountIdOf(claims) {
      const tid = str(claims.tid)
      const oid = str(claims.oid)
      return tid && oid ? entraAccountId(oid, tid) : null
    }
  }
}

function genericSetup(cfg: OidcSsoConfig): SsoProvider {
  const issuer = cfg.issuer.replace(/\/+$/, '')
  // An Entra issuer IS the Entra setup: same provider id and account keys, so a hub
  // moved from the tenant settings to these keeps every account.
  const entra = ENTRA_ISSUER.exec(issuer)
  if (entra && cfg.clientAuth.method === 'private_key_jwt') {
    return entraSetup({
      tenantId: entra[1]!,
      clientId: cfg.clientId,
      credential: cfg.clientAuth.credential,
      requireMfa: cfg.requireMfa,
      idpRoles: cfg.idpRoles ?? null,
      ...(cfg.fetch ? { fetch: cfg.fetch } : {})
    })
  }
  if (entra) {
    throw new Error('[hub-auth] an Entra issuer authenticates with a certificate, not a secret')
  }
  const scopes = cfg.scopes?.length ? [...cfg.scopes] : [...ENTRA_SCOPES]
  if (!scopes.includes('openid')) throw new Error('[hub-auth] OIDC scopes must include openid')
  const doFetch = cfg.fetch ?? fetch
  const roleMode = roleModeOf(cfg.idpRoles, 'hub')
  let discovery: Promise<Endpoints> | null = null
  return {
    providerId: OIDC_PROVIDER_ID,
    issuer,
    clientId: cfg.clientId,
    clientAuth: cfg.clientAuth,
    requireMfa: cfg.requireMfa,
    scopes,
    entraTenantId: null,
    roleMode,
    idpRoles: roleMode === 'idp' ? (cfg.idpRoles ?? null) : null,
    idTokenAlgs: GENERIC_ID_TOKEN_ALGS,
    fetch: doFetch,
    endpoints() {
      discovery ??= discover(issuer, doFetch).catch((err: unknown) => {
        discovery = null // retried at the next use
        throw err
      })
      return discovery
    },
    accountIdOf(claims) {
      const sub = str(claims.sub)
      return sub ? `${issuer}|${sub}` : null
    }
  }
}

/** A URL a discovery document may point the hub at: https, or http on loopback (tests). */
function safeEndpoint(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`[hub-auth] OIDC discovery has no ${what}`)
  const url = new URL(value)
  const loopback =
    url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`[hub-auth] OIDC ${what} must be https`)
  }
  return url.toString()
}

/** The issuer's discovery document, checked: its `issuer` is exactly ours. */
async function discover(issuer: string, doFetch: EntraFetch): Promise<Endpoints> {
  const res = await doFetch(`${issuer}/.well-known/openid-configuration`, {
    headers: { accept: 'application/json' },
    redirect: 'manual'
  })
  const doc = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok || !doc) throw new Error(`[hub-auth] OIDC discovery answered ${res.status}`)
  if (doc.issuer !== issuer) throw new Error('[hub-auth] OIDC discovery names another issuer')
  const algs = doc.token_endpoint_auth_signing_alg_values_supported
  return {
    authorization: safeEndpoint(doc.authorization_endpoint, 'authorization endpoint'),
    token: safeEndpoint(doc.token_endpoint, 'token endpoint'),
    jwks: safeEndpoint(doc.jwks_uri, 'key set'),
    ...(Array.isArray(algs) ? { assertionAlgs: algs.filter((a) => typeof a === 'string') } : {})
  }
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
 * A client assertion for one token request (`private_key_jwt`): `x5t#S256` (and, for a
 * generic issuer, `kid` — the same thumbprint, the key id to register), `aud` = the
 * token endpoint, `iss` = `sub` = the client id, a fresh `jti`, five minutes to live.
 * PS256 for Entra (Microsoft's documented shape); a generic issuer gets PS256 only when
 * its discovery lists it and RS256 is not, else RS256 (the most widely supported).
 */
export function signClientAssertion(
  cfg: { clientId: string; credential: EntraClientCredential },
  audience: string,
  nowMs: number = Date.now(),
  opts: { alg?: 'PS256' | 'RS256'; kid?: boolean } = {}
): string {
  const now = Math.floor(nowMs / 1000)
  const alg = opts.alg ?? 'PS256'
  const header = {
    alg,
    typ: 'JWT',
    'x5t#S256': cfg.credential.thumbprintS256,
    ...(opts.kid ? { kid: cfg.credential.thumbprintS256 } : {})
  }
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
    ...(alg === 'PS256'
      ? { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }
      : { padding: constants.RSA_PKCS1_PADDING })
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
  | 'no_mapped_role'
  | 'stale_evidence'
  | 'no_mfa'
  | 'no_email'
  | 'reserved_email'

export type EntraVerdict =
  | {
      ok: true
      /** The `account.accountId` (Entra `<oid>.<tid>`, generic `<issuer>|<sub>`). */
      accountId: string
      email: string
      name: string
      /** `entra-app-roles`: the app role's. `hub`, `idp`: null (decided elsewhere). */
      role: HubRole | null
      /** `idp`: the verified sign-in's role evidence (./idp-roles.ts persists it). */
      evidence: { subject: string; grants: string[]; verifiedAt: number } | null
    }
  | { ok: false; reason: EntraRefusal; accountId: string | null }

/** `<oid>.<tid>` — the identity key on an Entra `account` row. */
export function entraAccountId(oid: string, tid: string): string {
  return `${oid.toLowerCase()}.${tid.toLowerCase()}`
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

type KeyResolver = Parameters<typeof jwtVerify>[1]

/** The issuer every ID token of the Entra setup carries (v2.0 endpoint). */
export const entraIssuer = (cfg: EntraSsoConfig): string => ssoProvider(cfg).issuer

/**
 * SlayZone's precedence over the contract's mapped targets (`resolveTargets`, which may
 * only select a subset): one role, the highest — `admin` over `user`.
 */
export function highestHubRole(mapped: readonly string[]): string[] {
  if (mapped.includes('admin')) return ['admin']
  if (mapped.includes('user')) return ['user']
  return []
}

/**
 * Verify a token's signature, audience, lifetime and issuer (Entra: and `tid`). Throws
 * on any failure; returns the verified claims. Nothing is read from an unverified token.
 */
export async function verifyIdTokenClaims(
  provider: SsoProvider,
  idToken: string,
  keys: KeyResolver
): Promise<JWTPayload> {
  const { payload } = await jwtVerify(idToken, keys, {
    audience: provider.clientId,
    algorithms: [...provider.idTokenAlgs],
    clockTolerance: CLOCK_TOLERANCE_SEC
  })
  if (payload.iss !== provider.issuer) throw new IdTokenIssuerError()
  if (provider.entraTenantId && str(payload.tid)?.toLowerCase() !== provider.entraTenantId) {
    throw new IdTokenIssuerError()
  }
  // `azp`, when present on a token with several audiences, must be this client.
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== provider.clientId) {
    throw new IdTokenIssuerError()
  }
  return payload
}

class IdTokenIssuerError extends Error {
  constructor() {
    super('[hub-auth] ID token from another issuer')
    this.name = 'IdTokenIssuerError'
  }
}

/**
 * Verify an ID token and apply the hub's checks (see the module note). The signature,
 * audience and lifetime are verified FIRST (Entra signs every tenant with the same
 * keys, so a foreign tenant's token verifies and is then refused on its `tid`).
 */
export async function evaluateIdToken(
  provider: SsoProvider,
  idToken: string,
  keys: KeyResolver,
  nowSec: number = Math.floor(Date.now() / 1000)
): Promise<EntraVerdict> {
  let claims: JWTPayload
  try {
    claims = await verifyIdTokenClaims(provider, idToken, keys)
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof IdTokenIssuerError ? 'wrong_tenant' : 'invalid_token',
      accountId: null
    }
  }
  const accountId = provider.accountIdOf(claims)
  const refuse = (reason: EntraRefusal): EntraVerdict => ({ ok: false, reason, accountId })
  if (!accountId) return refuse('no_oid')

  let role: HubRole | null = null
  let evidence: Extract<EntraVerdict, { ok: true }>['evidence'] = null
  if (provider.roleMode === 'entra-app-roles') {
    const roles = strings(claims.roles)
    if (!roles.includes(ENTRA_USER_ROLE) && !roles.includes(ENTRA_ADMIN_ROLE)) {
      return refuse('unassigned')
    }
    role = roles.includes(ENTRA_ADMIN_ROLE) ? 'admin' : 'user'
  } else if (provider.roleMode === 'idp' && provider.idpRoles) {
    const grants = highestHubRole(resolveGrants(claims, provider.idpRoles))
    if (grants.length === 0) return refuse('no_mapped_role')
    // The sign-in's signed issue time IS the role evidence's time (contract): numeric,
    // not in the future, younger than the recheck interval.
    const iat = claims.iat
    const subject = str(claims.sub)
    if (
      typeof iat !== 'number' ||
      !Number.isInteger(iat) ||
      !subject ||
      freshness(nowSec, iat, provider.idpRoles.intervalSec) !== 'ok'
    ) {
      return refuse('stale_evidence')
    }
    evidence = { subject, grants, verifiedAt: iat }
  }
  if (provider.requireMfa && !strings(claims.amr).includes('mfa')) return refuse('no_mfa')
  const email = (str(claims.email) ?? str(claims.preferred_username))?.toLowerCase()
  if (!email) return refuse('no_email')
  // The hub's own accounts (break-glass, the computer service user) are never an SSO
  // identity, whatever an issuer lets a user put in their email claim.
  if (email === COMPUTER_SERVICE_USER_EMAIL || isBreakGlassEmail(email))
    return refuse('reserved_email')
  return { ok: true, accountId, email, name: str(claims.name) ?? email, role, evidence }
}

/** {@link evaluateIdToken} for the Entra setup (kept for callers of the T-09 API). */
export function evaluateEntraIdToken(
  cfg: SsoConfig,
  idToken: string,
  keys: KeyResolver
): Promise<EntraVerdict> {
  return evaluateIdToken(ssoProvider(cfg), idToken, keys)
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

/** This request's SSO sign-in, or null (no request, or not an SSO callback). */
export async function entraSignIn(): Promise<EntraSignIn | null> {
  return (await hasRequestState()) ? entraSignInState.get() : null
}

/** This request's verdict when it PASSED the checks, else null. */
export async function passedVerdict(): Promise<Extract<EntraVerdict, { ok: true }> | null> {
  const verdict = (await entraSignIn())?.verdict
  return verdict?.ok ? verdict : null
}

/** True inside an SSO callback whose ID token passed every check above (MFA included). */
export async function isPassedEntraSignIn(): Promise<boolean> {
  return (await passedVerdict()) !== null
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

/**
 * The token endpoint answered with an error. Carries only the HTTP status, the OAuth
 * `error` code and Entra's AADSTS number — never the request (code, assertion, refresh
 * token, secret) or the free-text description.
 */
export class EntraTokenError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly aadsts: string | null
  ) {
    super(
      `[hub-auth] OIDC token endpoint answered ${status} (${code}${aadsts ? `, ${aadsts}` : ''})`
    )
    this.name = 'EntraTokenError'
  }
}

/** The `fetch` discovery, the token endpoint and the key set are reached through. */
export type EntraFetch = typeof fetch

/**
 * One POST to the token endpoint, authenticated with a fresh client assertion or the
 * client secret (HTTP Basic). Throws {@link EntraTokenError} when the issuer answers
 * with an error; a network failure or a timeout throws whatever `fetch` threw.
 */
async function tokenRequest(
  provider: SsoProvider,
  params: Record<string, string>,
  opts: { fetch?: EntraFetch; signal?: AbortSignal } = {}
): Promise<OAuth2Tokens> {
  const endpoints = await provider.endpoints()
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json'
  }
  const body = new URLSearchParams({ ...params, client_id: provider.clientId })
  const auth = provider.clientAuth
  if (auth.method === 'private_key_jwt') {
    const generic = provider.entraTenantId === null
    const algs = endpoints.assertionAlgs
    const alg =
      !generic || (algs && !algs.includes('RS256') && algs.includes('PS256')) ? 'PS256' : 'RS256'
    body.set('client_assertion_type', JWT_BEARER)
    body.set(
      'client_assertion',
      signClientAssertion(
        { clientId: provider.clientId, credential: auth.credential },
        endpoints.token,
        Date.now(),
        { alg, kid: generic }
      )
    )
  } else {
    // RFC 6749 §2.3.1: form-urlencode, then Basic.
    const enc = (v: string) => encodeURIComponent(v).replace(/%20/g, '+')
    headers.authorization = `Basic ${Buffer.from(`${enc(provider.clientId)}:${enc(auth.secret)}`).toString('base64')}`
  }
  // `manual`: the code and the credential go to exactly one place, never on to
  // wherever a redirect points.
  const res = await (opts.fetch ?? provider.fetch)(endpoints.token, {
    method: 'POST',
    headers,
    body,
    redirect: 'manual',
    ...(opts.signal ? { signal: opts.signal } : {})
  })
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok || !data) {
    const code = str(data?.error) ?? 'no_body'
    const aadsts = /AADSTS\d+/.exec(String(data?.error_description ?? ''))?.[0] ?? null
    throw new EntraTokenError(res.status, code, aadsts)
  }
  return getOAuth2Tokens(data)
}

/**
 * Redeem a refresh token (the re-check, ./entra-recheck.ts, and the IdP-role
 * revalidation, ./idp-roles.ts): the same request, scopes and client authentication as
 * the provider's own refresh below.
 */
export function refreshEntraTokens(
  cfg: SsoConfig,
  refreshToken: string,
  opts: { fetch?: EntraFetch; signal?: AbortSignal } = {}
): Promise<OAuth2Tokens> {
  const provider = ssoProvider(cfg)
  return tokenRequest(
    provider,
    { grant_type: 'refresh_token', refresh_token: refreshToken, scope: provider.scopes.join(' ') },
    opts
  )
}

const keySets = new WeakMap<SsoProvider, KeyResolver>()

/** The issuer's signing keys (cached by jose, refetched on an unknown `kid`). */
export function entraKeySet(cfg: SsoConfig, fetchImpl?: EntraFetch): KeyResolver {
  const provider = ssoProvider(cfg)
  if (!fetchImpl) {
    const hit = keySets.get(provider)
    if (hit) return hit
  }
  const doFetch = fetchImpl ?? provider.fetch
  let remote: JWTVerifyGetKey | null = null
  const resolver: JWTVerifyGetKey = async (header, token) => {
    if (!remote) {
      const { jwks } = await provider.endpoints()
      remote = createRemoteJWKSet(new URL(jwks), { [customFetch]: doFetch })
    }
    return remote(header, token)
  }
  if (!fetchImpl) keySets.set(provider, resolver)
  return resolver
}

/** What a refreshed ID token says about the account (role mode `entra-app-roles` / `hub`). */
export type RefreshedIdTokenVerdict =
  /** `role: null`: the token carries no `roles` claim, or the hub manages roles. */
  | { ok: true; role: HubRole | null }
  | {
      ok: false
      /** `unassigned`: verified, this account, and it holds neither app role. The rest:
       *  the token could not be trusted (a key-set fetch failure lands here too). */
      reason: 'unassigned' | 'invalid_token' | 'wrong_tenant' | 'subject_mismatch'
    }

/**
 * The ID token a refresh returned (the hourly re-check of the modes that predate the
 * IdP-role mode), checked like a sign-in's and bound to the account it was refreshed
 * for. `amr` and the email are not re-checked: they describe the sign-in this token
 * descends from, which passed them.
 *
 * `entra-app-roles`: a token with NO `roles` claim is read as "no information", not as
 * "unassigned" (unchanged since T-12 — with "Assignment required" Entra refuses the
 * refresh itself, AADSTS50105, and every sign-in checks the roles); a `roles` claim that
 * holds neither app role is a definite `unassigned`. `hub`: roles are not read.
 * The IdP-role mode never comes here: ./idp-roles.ts revalidates through the contract.
 */
export async function evaluateRefreshedIdToken(
  cfg: SsoConfig,
  idToken: string,
  keys: KeyResolver,
  accountId: string
): Promise<RefreshedIdTokenVerdict> {
  const provider = ssoProvider(cfg)
  let claims: JWTPayload
  try {
    claims = await verifyIdTokenClaims(provider, idToken, keys)
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof IdTokenIssuerError ? 'wrong_tenant' : 'invalid_token'
    }
  }
  if (provider.accountIdOf(claims) !== accountId) return { ok: false, reason: 'subject_mismatch' }
  if (provider.roleMode !== 'entra-app-roles' || !Array.isArray(claims.roles)) {
    return { ok: true, role: null }
  }
  const roles = strings(claims.roles)
  if (roles.includes(ENTRA_ADMIN_ROLE)) return { ok: true, role: 'admin' }
  if (roles.includes(ENTRA_USER_ROLE)) return { ok: true, role: 'user' }
  return { ok: false, reason: 'unassigned' }
}

// ---------------------------------------------------------------------------
// Provider + plugin
// ---------------------------------------------------------------------------

/** What `getUserInfo` hands better-auth as the profile: only the verified account key. */
interface EntraProfile {
  accountId: string
}

/** Callbacks the auth instance wires in (auth.ts). */
export interface SsoHooks {
  /**
   * IdP-role mode: a verified sign-in with no mapped role. The identity's account, if
   * any, loses its managed role, sessions and user credentials (./idp-roles.ts).
   */
  onNoMappedRole?: (userId: string) => Promise<void>
}

/** The provider better-auth calls; see the module note for why it is not better-auth's. */
function ssoOAuthProvider(
  provider: SsoProvider,
  keys: KeyResolver,
  getContext: () => AuthContext | null,
  hooks: SsoHooks
): OAuthProvider<EntraProfile> {
  const id = provider.providerId
  return {
    id,
    name: provider.entraTenantId ? 'Microsoft Entra ID' : 'OpenID Connect',
    // Scopes are fixed: `c.body.scopes` from the sign-in request is not honoured, so
    // a client cannot widen what the hub asks the issuer for.
    createAuthorizationURL: async ({ state, codeVerifier, redirectURI, loginHint }) =>
      createAuthorizationURL({
        id,
        options: { clientId: provider.clientId },
        authorizationEndpoint: (await provider.endpoints()).authorization,
        state,
        codeVerifier,
        scopes: [...provider.scopes],
        redirectURI,
        loginHint
      }),
    async validateAuthorizationCode({ code, codeVerifier, redirectURI }) {
      // PKCE is not optional: better-auth always sends a verifier, so its absence
      // means something else called this.
      if (!codeVerifier) throw new Error('[hub-auth] OIDC code exchange without a PKCE verifier')
      const tokens = await tokenRequest(provider, {
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectURI,
        scope: provider.scopes.join(' ')
      })
      // Mark THIS request as an SSO sign-in carrying exactly this ID token.
      if (await hasRequestState()) {
        await entraSignInState.set({ idToken: tokens.idToken ?? null, verdict: null })
      }
      return tokens
    },
    // better-auth's `/refresh-token` and `/get-access-token` land here: same client
    // authentication.
    refreshAccessToken: (refreshToken) =>
      tokenRequest(provider, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: provider.scopes.join(' ')
      }),
    // The account key from the verdict `getUserInfo` hands over as the profile.
    // better-auth calls this only with a profile `getUserInfo` returned, i.e. after the
    // ID token passed every check.
    accountSubject: ({ profile }) => profile.accountId,
    async getUserInfo(tokens) {
      // Only inside the callback whose code exchange produced this very token.
      // Anything else that asks (better-auth's account-info route) gets nothing.
      const signIn = await entraSignIn()
      if (!signIn || !tokens.idToken || tokens.idToken !== signIn.idToken) return null
      const verdict = await evaluateIdToken(provider, tokens.idToken, keys)
      signIn.verdict = verdict
      if (!verdict.ok) {
        const userId = await auditRefusal(provider, verdict, getContext())
        if (verdict.reason === 'no_mapped_role' && userId) await hooks.onNoMappedRole?.(userId)
        return null
      }
      return {
        user: { email: verdict.email, name: verdict.name, emailVerified: false },
        data: { accountId: verdict.accountId }
      }
    },
    // New accounts are created on first sign-in (who may sign in is decided by the
    // checks above, not by an operator pre-creating rows); profile fields are not
    // rewritten on later sign-ins.
    disableSignUp: false,
    options: {
      clientId: provider.clientId,
      overrideUserInfoOnSignIn: false,
      // No ID-token sign-in: a client handing the hub a token it obtained elsewhere is
      // refused. Only the code flow this hub runs itself signs anyone in.
      disableIdTokenSignIn: true
    }
  }
}

/** One `auth.signin` denied line for a refused ID token. Names the account when one
 *  exists (returned); otherwise a keyed hash of the identity so repeats correlate. */
async function auditRefusal(
  provider: SsoProvider,
  verdict: Extract<EntraVerdict, { ok: false }>,
  ctx: AuthContext | null
): Promise<string | null> {
  let userId: string | null = null
  try {
    if (verdict.accountId && ctx) {
      const account = await ctx.internalAdapter.findAccountByKey({
        providerId: provider.providerId,
        accountId: verdict.accountId
      })
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
  return userId
}

/** The SSO config of an instance, by the plugin that installed it. */
const configs = new WeakMap<object, SsoConfig>()

/**
 * The plugin that installs the SSO provider. Its presence on an instance is what makes
 * a hub an "SSO hub" ({@link isEntraSsoAuth}).
 */
export function entraSso(cfg: SsoConfig, hooks: SsoHooks = {}) {
  const provider = ssoProvider(cfg)
  // One key set per instance: jose caches the issuer's keys and refetches on an
  // unknown `kid` (issuers rotate their signing keys).
  const keys = entraKeySet(cfg)
  let context: AuthContext | null = null
  const plugin = {
    id: ENTRA_PLUGIN_ID,
    init(ctx) {
      context = ctx
      return {
        context: {
          socialProviders: [
            ssoOAuthProvider(provider, keys, () => context, hooks),
            ...ctx.socialProviders.filter((p) => p.id !== provider.providerId)
          ]
        }
      }
    }
  } satisfies BetterAuthPlugin
  configs.set(plugin, cfg)
  return plugin
}

/** True for an instance built with SSO sign-in. */
export function isEntraSsoAuth(auth: { options: { plugins?: ReadonlyArray<{ id: string }> } }) {
  return auth.options.plugins?.some((p) => p.id === ENTRA_PLUGIN_ID) === true
}

/** The resolved SSO provider of an instance, or null without SSO. */
export function ssoProviderOf(auth: {
  options: { plugins?: ReadonlyArray<{ id: string }> }
}): SsoProvider | null {
  const plugin = auth.options.plugins?.find((p) => p.id === ENTRA_PLUGIN_ID)
  const cfg = plugin ? configs.get(plugin) : undefined
  return cfg ? ssoProvider(cfg) : null
}

/**
 * What clients call this hub's SSO sign-in ("Sign in with <label>", `/health`
 * `ssoLabel`): `Microsoft` for the Entra setup, `SSO` for a generic OpenID provider.
 */
export function ssoDisplayLabelOf(auth: {
  options: { plugins?: ReadonlyArray<{ id: string }> }
}): string {
  const provider = ssoProviderOf(auth)
  return !provider || provider.entraTenantId ? 'Microsoft' : 'SSO'
}

/** The better-auth provider id SSO sign-in starts with (`microsoft` or `oidc`). */
export function ssoProviderIdOf(auth: {
  options: { plugins?: ReadonlyArray<{ id: string }> }
}): string {
  return ssoProviderOf(auth)?.providerId ?? ENTRA_PROVIDER_ID
}

// ---------------------------------------------------------------------------
// Database hooks (wired in auth.ts)
// ---------------------------------------------------------------------------

/**
 * `databaseHooks.user.create.before`: an account created by an SSO sign-in starts with
 * the role its role mode gives — the app role's (`entra-app-roles`), the highest
 * mapped grant (`idp`; ./idp-roles.ts writes the evidence with the session), or
 * `roleForNewAccount()` (`hub`: as an operator-created account on that hub).
 */
export async function entraUserCreateBefore(
  user: Record<string, unknown>,
  roleForNewAccount: () => Promise<HubRole>
): Promise<{ data: Record<string, unknown> } | undefined> {
  const verdict = await passedVerdict()
  if (!verdict) return undefined
  const role: HubRole = verdict.evidence
    ? readRole(verdict.evidence.grants[0])
    : (verdict.role ?? (await roleForNewAccount()))
  return { data: { ...user, role } }
}

/** `databaseHooks.user.create.after`: the `user.create` line for an account an SSO
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
 * The account a passed sign-in's session is for, checked: fails CLOSED if the session
 * is not for the account the token names. Null outside a passed SSO callback.
 */
export async function signedInAccount(
  session: { userId?: unknown },
  ctx: GenericEndpointContext | null
): Promise<{ verdict: Extract<EntraVerdict, { ok: true }>; userId: string } | null> {
  const verdict = await passedVerdict()
  if (!verdict) return null
  const adapter = ctx?.context.internalAdapter
  if (!adapter) throw new Error('[hub-auth] SSO sign-in without an auth context')
  const provider = ssoProviderOf({
    options: ctx.context.options as { plugins?: ReadonlyArray<{ id: string }> }
  })
  const providerIds = provider ? [provider.providerId] : SSO_PROVIDER_IDS
  for (const providerId of providerIds) {
    const account = await adapter.findAccountByKey({ providerId, accountId: verdict.accountId })
    if (!account) continue
    if (account.userId !== session.userId) break
    return { verdict, userId: account.userId }
  }
  throw new Error('[hub-auth] SSO sign-in session does not match the signed-in identity')
}

/**
 * `databaseHooks.session.create.before`, after the disabled-account guard, role mode
 * `entra-app-roles` only: the session an Entra sign-in creates first sets the account's
 * role from the token (O-4). (`idp`: ./idp-roles.ts. `hub`: nothing.)
 */
export async function syncEntraRole(
  session: { userId?: unknown },
  ctx: GenericEndpointContext | null
): Promise<void> {
  const signedIn = await signedInAccount(session, ctx)
  if (!signedIn || signedIn.verdict.role === null || signedIn.verdict.evidence) return
  const { verdict, userId } = signedIn
  const adapter = ctx!.context.internalAdapter
  const user = (await adapter.findUserById(userId)) as Record<string, unknown> | null
  if (!user || readRole(user.role) === verdict.role) return
  await adapter.updateUser(userId, { role: verdict.role })
  securityEvent({
    event: 'user.role_change',
    outcome: 'success',
    actor: null,
    targetKind: 'user',
    targetId: userId,
    detail: { reason: 'sso_claim', role: verdict.role }
  })
}
