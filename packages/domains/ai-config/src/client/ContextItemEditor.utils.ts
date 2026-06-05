export interface JsonValidation {
  isJson: boolean
  jsonError: string | null
}

export function getJsonValidation(slug: string, content: string): JsonValidation {
  const isJson = slug.endsWith('.json')
  const jsonError =
    isJson && content.trim()
      ? (() => {
          try {
            JSON.parse(content)
            return null
          } catch (e) {
            return (e as Error).message
          }
        })()
      : null
  return { isJson, jsonError }
}
