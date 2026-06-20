export interface ViewerProfile {
  image: string | null
  githubLogin: string | null
  githubNumericId?: string | null
}

export function formatTokens(value: number): string {
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : `${Math.round(value / 1_000)}k`
}

export function initials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

function parseGithubNumericIdFromAvatarUrl(image: string | null | undefined): string | null {
  if (!image) return null
  try {
    const parsed = new URL(image)
    const match = parsed.pathname.match(/^\/u\/(\d+)(?:\/|$)/)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

export function getGithubNumericId(viewer: ViewerProfile | null): string | null {
  if (!viewer) return null
  return viewer.githubNumericId ?? parseGithubNumericIdFromAvatarUrl(viewer.image)
}

export function getAvatarSrc(viewer: ViewerProfile | null): string | null {
  if (!viewer) return null
  if (viewer.image) return viewer.image
  if (viewer.githubLogin) return `https://github.com/${viewer.githubLogin}.png?size=96`
  const numericId = getGithubNumericId(viewer)
  if (numericId) return `https://avatars.githubusercontent.com/u/${numericId}?v=4`
  return null
}

export function getGithubProfileUrl(viewer: ViewerProfile | null): string | null {
  if (!viewer) return null
  if (viewer.githubLogin) return `https://github.com/${viewer.githubLogin}`
  const numericId = getGithubNumericId(viewer)
  if (numericId) return `https://github.com/u/${numericId}`
  return null
}

export function hasResolvedGithubIdentity(viewer: ViewerProfile | null): boolean {
  if (!viewer) return false
  return Boolean(viewer.githubLogin && viewer.image && getGithubProfileUrl(viewer))
}
