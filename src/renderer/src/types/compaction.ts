export const CONVERSATION_COMPACTION_VERSION = 1

export type ConversationCompactionSegment = {
  id: string
  createdAt: string
  startMessageId: string
  endMessageId: string
  startMessageCreatedAt: string
  endMessageCreatedAt: string
  messageCount: number
  overlapMessageCount: number
  summary: string
  sourceTokenEstimate: number
  summaryTokenEstimate: number
  modelId: string
  modelName: string
}

export type ConversationCompactionState = {
  version: number
  updatedAt: string
  maxContextTokens: number
  softLimitTokens: number
  hardLimitTokens: number
  compactedMessageCount: number
  sourceTokenEstimate: number
  summaryTokenEstimate: number
  lastCompactedMessageId: string
  segments: ConversationCompactionSegment[]
}

export type CompactConversationResult =
  | {
      status: 'success'
      state: ConversationCompactionState
      addedSegments: number
      compactedMessageCount: number
    }
  | {
      status: 'noop'
      reason: 'not_enough_messages' | 'already_compact'
    }
  | {
      status: 'error'
      reason: 'summary_failed'
      message?: string
    }
