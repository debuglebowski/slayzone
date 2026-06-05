import type { CliProvider } from '../shared'
import { PROVIDER_PATHS } from '../shared/provider-registry'

export function providerSupportsType(provider: CliProvider): boolean {
  return !!PROVIDER_PATHS[provider]?.skillsDir
}
