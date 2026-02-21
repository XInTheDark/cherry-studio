export type ConversationThreadScope = 'home' | 'canvas' | 'session'
export type ConversationThreadTopicType = 'chat' | 'session'

/**
 * Unified thread metadata record.
 *
 * Message bodies/blocks remain in Dexie `topics` + `message_blocks`.
 * This table stores lightweight metadata used by list UIs and routing.
 */
export type ConversationThreadRecord = {
  id: string
  topicId: string
  scope: ConversationThreadScope
  assistantId: string
  topicType?: ConversationThreadTopicType
  createdAt: string
  updatedAt: string
  name?: string
  pinned?: boolean
  isNameManuallyEdited?: boolean

  // Canvas-scoped metadata
  canvasId?: string
  lastActiveAt?: string
}
