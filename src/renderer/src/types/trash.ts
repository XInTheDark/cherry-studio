/**
 * Metadata for a topic that has been moved to Trash.
 *
 * Notes:
 * - We store *metadata only*; actual messages remain in Dexie until permanently deleted.
 * - This intentionally does NOT store topic messages.
 */
export type TrashedTopic = {
  id: string
  /** Original assistant the topic belonged to at the time it was trashed. */
  assistantId: string
  topic: {
    id: string
    assistantId: string
    name: string
    createdAt: string
    updatedAt: string
    pinned?: boolean
    prompt?: string
    isNameManuallyEdited?: boolean
    // Keep the Topic shape compatible with existing UI, but never store messages in Trash metadata.
    messages: []
  }
  trashedAt: string
}
