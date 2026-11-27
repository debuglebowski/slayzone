import type { HubConnection } from '@slayzone/transport/client'
import type { StatusTone } from '@slayzone/ui'

export { StatusDot, type StatusTone } from '@slayzone/ui'

export function toneOfConnection(connection: HubConnection | null): StatusTone {
  if (!connection) return 'idle'
  if (connection.status === 'open') return 'ok'
  return connection.error ? 'bad' : 'idle'
}
