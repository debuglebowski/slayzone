import { TypedEmitter } from '@slayzone/platform/events'
import type { AgentLifecycleEventMap } from '@slayzone/terminal/server'

export const agentLifecycleEvents = new TypedEmitter<AgentLifecycleEventMap>()
