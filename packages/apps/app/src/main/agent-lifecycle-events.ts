import { TypedEmitter } from '@slayzone/platform/events'
import type { AgentLifecycleEventMap } from '@slayzone/api'

export const agentLifecycleEvents = new TypedEmitter<AgentLifecycleEventMap>()
