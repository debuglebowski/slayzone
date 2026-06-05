export const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

export const isValidRegex = (pattern: string) => {
  try {
    new RegExp(pattern)
    return true
  } catch {
    return false
  }
}
