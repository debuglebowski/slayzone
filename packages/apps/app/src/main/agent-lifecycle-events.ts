import { TypedEmitter } from '@slayzone/platform/events'
import type { AgentLifecycleEventMap } from '@slayzone/transport/server'

export const agentLifecycleEvents = new TypedEmitter<AgentLifecycleEventMap>()
