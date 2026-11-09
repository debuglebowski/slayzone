/**
 * The SSO setup hub-auth runs with, from what the boot rules settled (B7 + B20): the
 * Entra tenant setup, or a generic OpenID issuer with a certificate or a client secret;
 * and the IdP-role mode's config when it is on. Pure: the certificate is already loaded.
 *
 * @module hub/sso-config
 */
import type { EntraClientCredential, SsoConfig } from '@slayzone/hub-auth/server'
import type { HubSsoBootConfig } from './boot-rules.js'

export function ssoConfigFromBoot(boot: HubSsoBootConfig<EntraClientCredential>): SsoConfig {
  const idpRoles = boot.idpRoles
  if (boot.tenantId !== undefined) {
    if (!boot.credential) throw new Error('[slayzone] the Entra tenant setup needs its certificate')
    return {
      tenantId: boot.tenantId,
      clientId: boot.clientId,
      credential: boot.credential,
      requireMfa: boot.requireMfa,
      idpRoles
    }
  }
  if (boot.issuer === undefined) throw new Error('[slayzone] SSO without an issuer')
  return {
    issuer: boot.issuer,
    clientId: boot.clientId,
    clientAuth: boot.credential
      ? { method: 'private_key_jwt', credential: boot.credential }
      : { method: 'client_secret_basic', secret: boot.clientSecret ?? '' },
    requireMfa: boot.requireMfa,
    ...(boot.scopes ? { scopes: boot.scopes } : {}),
    idpRoles
  }
}
