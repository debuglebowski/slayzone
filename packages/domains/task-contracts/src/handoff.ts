import type { DesktopHandoffPolicy } from './types'

export const BLOCKED_EXTERNAL_PROTOCOLS = [
  'figma',
  'notion',
  'slack',
  'linear',
  'vscode',
  'cursor'
] as const

const LEGACY_PROTOCOL = 'figma'
const LEGACY_HOST_SCOPE = 'figma.com'
const COMMON_HOST_PREFIXES = new Set(['www', 'app', 'web', 'accounts'])

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const isHostFamily = (hostname: string, target: string): boolean =>
  hostname === target || hostname.endsWith(`.${target}`)

export const isLoopbackHost = (value: string | null | undefined): boolean => {
  const normalized = normalizeDesktopHostScope(value)
  if (!normalized) return false
  if (normalized === 'localhost' || normalized === '[::1]' || normalized === '::1') return true
  return /^127(?:\.\d{1,3}){3}$/.test(normalized)
}

export const isLoopbackUrl = (rawUrl: string): boolean => {
  try {
    return isLoopbackHost(new URL(rawUrl).hostname)
  } catch {
    return false
  }
}

export const isUrlWithinHostScope = (
  rawUrl: string,
  hostScope: string | null | undefined
): boolean => {
  const normalizedScope = normalizeDesktopHostScope(hostScope)
  if (!normalizedScope) return false
  try {
    const parsed = new URL(rawUrl)
    return isHostFamily(parsed.hostname.toLowerCase(), normalizedScope)
  } catch {
    return false
  }
}

export const normalizeDesktopProtocol = (value: string | null | undefined): string | null => {
  const normalized = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/:\/\/*$/, '')
  if (!normalized) return null
  if (!/^[a-z][a-z0-9+.-]*$/.test(normalized)) return null
  return normalized
}

export const normalizeDesktopHostScope = (value: string | null | undefined): string | null => {
  const normalized = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
  return normalized || null
}

export const inferHostScopeFromUrl = (rawUrl: string): string | null => {
  try {
    const normalized = normalizeDesktopHostScope(new URL(rawUrl).hostname)
    if (!normalized) return null
    const labels = normalized.split('.').filter(Boolean)
    while (labels.length > 2 && COMMON_HOST_PREFIXES.has(labels[0])) labels.shift()
    return labels.join('.')
  } catch {
    return null
  }
}

export const inferProtocolFromUrl = (rawUrl: string): string | null => {
  const hostScope = inferHostScopeFromUrl(rawUrl)
  if (!hostScope) return null

  const labels = hostScope.split('.').filter(Boolean)
  while (labels.length > 1 && COMMON_HOST_PREFIXES.has(labels[0])) labels.shift()
  return normalizeDesktopProtocol(labels[0] ?? null)
}

const resolveDesktopHandoffPolicy = (
  policy?: DesktopHandoffPolicy | null
): DesktopHandoffPolicy | null => {
  // Explicit policy only; callers should pass null to disable matching.
  if (policy === undefined) return null
  if (policy === null) return null

  const protocol = normalizeDesktopProtocol(policy.protocol)
  if (!protocol) return null

  const hostScope =
    normalizeDesktopHostScope(policy.hostScope) ??
    (protocol === LEGACY_PROTOCOL ? LEGACY_HOST_SCOPE : undefined)
  return hostScope ? { protocol, hostScope } : { protocol }
}

export const isBlockedExternalProtocolUrl = (rawUrl: string): boolean => {
  try {
    const parsed = new URL(rawUrl)
    const protocol = parsed.protocol.toLowerCase().replace(/:$/, '')
    return BLOCKED_EXTERNAL_PROTOCOLS.some((scheme) => scheme === protocol)
  } catch {
    return false
  }
}

export const isEncodedDesktopHandoffUrl = (
  rawUrl: string,
  policy?: DesktopHandoffPolicy | null
): boolean => {
  try {
    const parsed = new URL(rawUrl)
    const resolved = resolveDesktopHandoffPolicy(policy)
    if (!resolved) return false
    const normalizedHost = parsed.hostname.toLowerCase()

    if (resolved.hostScope && !isUrlWithinHostScope(rawUrl, resolved.hostScope)) return false

    const decodedLower = safeDecodeURIComponent(rawUrl).toLowerCase()
    const protocolNeedle = `${resolved.protocol}://`
    if (decodedLower.includes(protocolNeedle)) return true

    // Keep legacy Figma /exit behavior for compatibility.
    if (
      resolved.protocol === LEGACY_PROTOCOL &&
      isHostFamily(normalizedHost, LEGACY_HOST_SCOPE) &&
      parsed.pathname.toLowerCase() === '/exit'
    ) {
      return true
    }

    return false
  } catch {
    return false
  }
}

export const isBlockedExternalHandoffUrl = (
  rawUrl: string,
  policy?: DesktopHandoffPolicy | null
): boolean => isBlockedExternalProtocolUrl(rawUrl) || isEncodedDesktopHandoffUrl(rawUrl, policy)
