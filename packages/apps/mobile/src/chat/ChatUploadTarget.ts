/**
 * Where a chat's attached files are uploaded: the hub that owns the task, as its REST
 * target (`hubTarget`). Provided by the task page, which knows the hub session; a chat
 * without one (no provider) offers no attach button.
 */
import { createContext, useContext } from 'react'
import type { HubTarget } from '../artifacts/hub-rest'

export const ChatUploadTargetContext = createContext<HubTarget | null>(null)

export function useChatUploadTarget(): HubTarget | null {
  return useContext(ChatUploadTargetContext)
}
