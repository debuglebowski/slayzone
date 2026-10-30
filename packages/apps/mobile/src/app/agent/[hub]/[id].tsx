import { useLocalSearchParams, useRouter } from 'expo-router'
import { AgentScreen } from '../../../AgentScreen'
import { HOME } from '../../../routes'

/** `/agent/<hub address>/<session id>`: an agent session (placeholder until the agents phase). */
export default function AgentRoute() {
  const { hub } = useLocalSearchParams<{ hub: string; id: string }>()
  const router = useRouter()
  return (
    <AgentScreen
      hubAddress={hub}
      onBack={() => (router.canGoBack() ? router.back() : router.replace(HOME))}
    />
  )
}
