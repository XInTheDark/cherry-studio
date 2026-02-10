import { loggerService } from '@logger'
import { CONTEXT_HARD_SAFETY_MARGIN_TOKENS, UNLIMITED_MAX_CONTEXT_TOKENS } from '@renderer/config/constant'
import { dbService } from '@renderer/services/db'
import type {
  Assistant,
  CompactConversationResult,
  ConversationCompactionSegment,
  ConversationCompactionState,
  Model
} from '@renderer/types'
import { CONVERSATION_COMPACTION_VERSION } from '@renderer/types/compaction'
import type { Message } from '@renderer/types/newMessage'
import { uuid } from '@renderer/utils'
import { filterAfterContextClearMessages } from '@renderer/utils/messageUtils/filters'
import {
  findFileBlocks,
  findToolBlocks,
  getCitationContent,
  getMainTextContent,
  getThinkingContent
} from '@renderer/utils/messageUtils/find'
import type { ModelMessage } from 'ai'
import { approximateTokenSize } from 'tokenx'

import { fetchGenerate, hasApiKey } from './ApiService'
import { getAssistantSettings, getDefaultModel, getProviderByModel, getQuickModel } from './AssistantService'
import {
  estimateMessageContextTokens,
  estimateMessagesContextTokens,
  normalizeMaxContextTokens
} from './ContextWindowService'

const logger = loggerService.withContext('ConversationCompactionService')

const SOFT_LIMIT_RATIO = 0.75
const SOFT_LIMIT_HEADROOM_TOKENS = 50_000
const DEFAULT_UNLIMITED_HARD_LIMIT_TOKENS = 300_000
const AUTO_COMPACTION_ERROR_COOLDOWN_MS = 10 * 60 * 1000
const SUMMARY_BUDGET_RATIO = 0.35
const SUMMARY_BUDGET_MIN_TOKENS = 2_000
const CHUNK_TARGET_RATIO = 0.28
const CHUNK_MIN_TOKENS = 6_000
const CHUNK_MAX_TOKENS = 32_000
const CHUNK_OVERLAP_MESSAGE_COUNT = 2
// These constants are tuned minimums. So we still keep a small live tail so the model has verbatim recent context.
const MIN_MESSAGES_TO_KEEP_LIVE = 2
const MIN_MESSAGES_TO_COMPACT = 3 // so, total messages needed to compact = KEEP_LIVE + COMPACT
const MAX_MAIN_TEXT_CHARS = 8_000
const MAX_THINKING_CHARS = 4_000
const MAX_TOOL_PAYLOAD_CHARS = 3_500
const MAX_CITATION_CHARS = 2_000

const COMPACTION_SUMMARY_PROMPT = `You are compacting a conversation history for future model turns.

Task:
- Summarize the provided message chunk faithfully and in detail.
- Preserve chronology and causality.
- Keep user intent, constraints, decisions, unresolved items, and exact technical details.
- Do not invent facts.

Output format (markdown with these exact section titles):
## User Goals and Constraints
## Decisions and Rationale
## Actions Taken and Results
## Tooling and External Data
## Open Questions and Risks
## Continuity Notes

Rules:
- Keep concrete technical details (APIs, file paths, command names, model/provider choices, limits, schemas, errors).
- Explicitly call out assumptions and unknowns.
- Capture state transitions and what changed compared to earlier turns.
- Keep it concise but information-dense.`

type ChunkPlan = {
  messages: Message[]
  overlapMessageCount: number
}

type ResolvedCompactionState = {
  state?: ConversationCompactionState
  lastCompactedIndex: number
}

export type CompactionContextWindow = {
  summaryMessages: ModelMessage[]
  summaryTokenEstimate: number
  liveMessages: Message[]
  adjustedMaxContextTokens: number
  compactedUntilMessageId?: string
  compactionState?: ConversationCompactionState
}

function truncate(value: string | undefined, limit: number): string {
  if (!value) return ''
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]`
}

function estimateSystemMessageTokens(content: string): number {
  return approximateTokenSize(content) + 12
}

function getActiveMessages(messages: Message[]): Message[] {
  return filterAfterContextClearMessages(messages)
}

function getEffectiveHardLimitTokens(maxContextTokens: number): number {
  const normalized = normalizeMaxContextTokens(maxContextTokens)

  if (!Number.isFinite(normalized) || normalized === Number.MAX_SAFE_INTEGER) {
    return DEFAULT_UNLIMITED_HARD_LIMIT_TOKENS
  }

  return Math.max(2_048, normalized)
}

export function getSoftContextLimitTokens(maxContextTokens: number): number {
  const hardLimit = getEffectiveHardLimitTokens(maxContextTokens)
  const byRatio = Math.floor(hardLimit * SOFT_LIMIT_RATIO)
  const byHeadroom = Math.max(1, hardLimit - SOFT_LIMIT_HEADROOM_TOKENS)
  const candidate = Math.max(byRatio, byHeadroom)

  if (hardLimit <= 4_096) {
    return Math.max(1_024, Math.floor(hardLimit * 0.9))
  }

  return Math.max(1_024, Math.min(candidate, hardLimit - CONTEXT_HARD_SAFETY_MARGIN_TOKENS))
}

function resolveExistingState(messages: Message[], state?: ConversationCompactionState): ResolvedCompactionState {
  if (!state || !state.segments?.length || !state.lastCompactedMessageId) {
    return { lastCompactedIndex: -1 }
  }

  const lastCompactedIndex = messages.findIndex((message) => message.id === state.lastCompactedMessageId)
  if (lastCompactedIndex < 0) {
    return { lastCompactedIndex: -1 }
  }

  return { state, lastCompactedIndex }
}

function buildChunkPlans(messages: Message[], chunkTargetTokens: number): ChunkPlan[] {
  if (!messages.length) {
    return []
  }

  const plans: ChunkPlan[] = []
  let cursor = 0

  while (cursor < messages.length) {
    let endExclusive = cursor
    let usedTokens = 0

    while (endExclusive < messages.length) {
      const messageTokens = estimateMessageContextTokens(messages[endExclusive])
      const nextUsed = usedTokens + messageTokens
      if (endExclusive > cursor && nextUsed > chunkTargetTokens) {
        break
      }

      usedTokens = nextUsed
      endExclusive += 1
    }

    const chunk = messages.slice(cursor, endExclusive)
    if (!chunk.length) {
      break
    }

    const overlapMessageCount = cursor === 0 ? 0 : Math.min(CHUNK_OVERLAP_MESSAGE_COUNT, chunk.length - 1)
    plans.push({ messages: chunk, overlapMessageCount })

    if (endExclusive >= messages.length) {
      break
    }

    cursor = Math.max(endExclusive - CHUNK_OVERLAP_MESSAGE_COUNT, cursor + 1)
  }

  return plans
}

function buildSegmentSystemMessage(segment: ConversationCompactionSegment, index: number, total: number): string {
  return [
    `[Compacted conversation segment ${index}/${total}]`,
    `Range: ${segment.startMessageCreatedAt} -> ${segment.endMessageCreatedAt}`,
    `Messages: ${segment.messageCount} (overlap: ${segment.overlapMessageCount})`,
    `Source tokens≈${segment.sourceTokenEstimate}, summary tokens≈${segment.summaryTokenEstimate}`,
    segment.summary
  ].join('\n')
}

function buildSummaryMessages(
  segments: ConversationCompactionSegment[],
  hardLimitTokens: number
): { summaryMessages: ModelMessage[]; summaryTokenEstimate: number } {
  if (!segments.length) {
    return { summaryMessages: [], summaryTokenEstimate: 0 }
  }

  const budget = Math.max(SUMMARY_BUDGET_MIN_TOKENS, Math.floor(hardLimitTokens * SUMMARY_BUDGET_RATIO))
  const selected: ConversationCompactionSegment[] = []
  let used = 0

  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const candidate = segments[i]
    const content = buildSegmentSystemMessage(candidate, i + 1, segments.length)
    const tokens = estimateSystemMessageTokens(content)

    if (selected.length > 0 && used + tokens > budget) {
      break
    }

    selected.push(candidate)
    used += tokens
  }

  selected.reverse()

  const summaryMessages: ModelMessage[] = selected.map((segment, index) => ({
    role: 'system',
    content: buildSegmentSystemMessage(segment, segments.length - selected.length + index + 1, segments.length)
  }))

  const summaryTokenEstimate = summaryMessages.reduce((acc, message) => {
    const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
    return acc + estimateSystemMessageTokens(content)
  }, 0)

  return { summaryMessages, summaryTokenEstimate }
}

function buildSummaryInputMessages(chunk: Message[]): string {
  const payload = chunk.map((message, index) => {
    const text = truncate(getMainTextContent(message), MAX_MAIN_TEXT_CHARS)
    const thinking = truncate(getThinkingContent(message), MAX_THINKING_CHARS)
    const citations = truncate(getCitationContent(message), MAX_CITATION_CHARS)
    const fileBlocks = findFileBlocks(message)
    const toolBlocks = findToolBlocks(message)

    return {
      idx: index + 1,
      id: message.id,
      askId: message.askId,
      role: message.role,
      createdAt: message.createdAt,
      type: message.type,
      text,
      thinking: thinking || undefined,
      citations: citations || undefined,
      files: fileBlocks.map((block) => block.file?.origin_name || block.file?.name).filter(Boolean),
      tools: toolBlocks
        .map((block) => {
          const response = block.metadata?.rawMcpToolResponse
          if (!response) return undefined

          return {
            name: response.tool?.name,
            status: response.status,
            arguments: truncate(
              typeof response.arguments === 'string' ? response.arguments : JSON.stringify(response.arguments),
              MAX_TOOL_PAYLOAD_CHARS
            ),
            result: truncate(
              typeof response.response === 'string' ? response.response : JSON.stringify(response.response),
              MAX_TOOL_PAYLOAD_CHARS
            )
          }
        })
        .filter(Boolean)
    }
  })

  return JSON.stringify(payload, null, 2)
}

async function summarizeChunk(model: Model, chunk: Message[]): Promise<string> {
  const content = buildSummaryInputMessages(chunk)
  const summary = await fetchGenerate({
    prompt: COMPACTION_SUMMARY_PROMPT,
    content,
    model
  })

  return summary.trim()
}

function getAdjustedMaxContextTokens(maxContextTokens: number, summaryTokenEstimate: number): number {
  if (maxContextTokens >= UNLIMITED_MAX_CONTEXT_TOKENS) {
    return maxContextTokens
  }

  return Math.max(1, maxContextTokens - summaryTokenEstimate)
}

async function getCompactionModel(assistant: Assistant): Promise<Model> {
  return getQuickModel() || assistant.model || getDefaultModel()
}

function buildSegment(
  chunk: Message[],
  summary: string,
  model: Model,
  overlapMessageCount: number
): ConversationCompactionSegment {
  const sourceTokenEstimate = estimateMessagesContextTokens(chunk)
  return {
    id: uuid(),
    createdAt: new Date().toISOString(),
    startMessageId: chunk[0].id,
    endMessageId: chunk[chunk.length - 1].id,
    startMessageCreatedAt: chunk[0].createdAt,
    endMessageCreatedAt: chunk[chunk.length - 1].createdAt,
    messageCount: chunk.length,
    overlapMessageCount,
    summary,
    sourceTokenEstimate,
    summaryTokenEstimate: estimateSystemMessageTokens(summary),
    modelId: model.id,
    modelName: model.name
  }
}

export class ConversationCompactionService {
  private static autoCompactionInFlightTopics = new Set<string>()
  private static autoCompactionCooldownUntil = new Map<string, number>()

  static async resolveContextWindow({
    topicId,
    messages,
    maxContextTokens
  }: {
    topicId?: string
    messages: Message[]
    maxContextTokens: number
  }): Promise<CompactionContextWindow> {
    const hardLimitTokens = getEffectiveHardLimitTokens(maxContextTokens)
    const activeMessages = getActiveMessages(messages)

    if (!topicId || !activeMessages.length) {
      return {
        summaryMessages: [],
        summaryTokenEstimate: 0,
        liveMessages: activeMessages,
        adjustedMaxContextTokens: maxContextTokens
      }
    }

    const rawState = await dbService.getCompactionState(topicId)
    const { state, lastCompactedIndex } = resolveExistingState(activeMessages, rawState)

    if (!state || lastCompactedIndex < 0) {
      if (rawState) {
        await dbService.clearCompactionState(topicId)
      }

      return {
        summaryMessages: [],
        summaryTokenEstimate: 0,
        liveMessages: activeMessages,
        adjustedMaxContextTokens: maxContextTokens
      }
    }

    const liveMessages = activeMessages.slice(lastCompactedIndex + 1)
    const { summaryMessages, summaryTokenEstimate } = buildSummaryMessages(state.segments, hardLimitTokens)

    return {
      summaryMessages,
      summaryTokenEstimate,
      liveMessages,
      adjustedMaxContextTokens: getAdjustedMaxContextTokens(maxContextTokens, summaryTokenEstimate),
      compactedUntilMessageId: state.lastCompactedMessageId,
      compactionState: state
    }
  }

  static async getCompactionState(topicId: string): Promise<ConversationCompactionState | undefined> {
    return dbService.getCompactionState(topicId)
  }

  static async clearCompaction(topicId: string): Promise<void> {
    await dbService.clearCompactionState(topicId)
  }

  static async compactConversation({
    topicId,
    assistant,
    messages
  }: {
    topicId: string
    assistant: Assistant
    messages: Message[]
  }): Promise<CompactConversationResult> {
    const activeMessages = getActiveMessages(messages)
    if (activeMessages.length < MIN_MESSAGES_TO_KEEP_LIVE + MIN_MESSAGES_TO_COMPACT) {
      return { status: 'noop', reason: 'not_enough_messages' }
    }

    const { maxContextTokens } = getAssistantSettings(assistant)
    const hardLimitTokens = getEffectiveHardLimitTokens(maxContextTokens)
    const softLimitTokens = getSoftContextLimitTokens(maxContextTokens)

    const persistedState = await dbService.getCompactionState(topicId)
    const { state: existingState, lastCompactedIndex } = resolveExistingState(activeMessages, persistedState)
    const startIndex = lastCompactedIndex + 1
    const candidates = activeMessages.slice(startIndex)

    if (candidates.length < MIN_MESSAGES_TO_KEEP_LIVE + MIN_MESSAGES_TO_COMPACT) {
      return { status: 'noop', reason: existingState ? 'already_compact' : 'not_enough_messages' }
    }

    if (!existingState && estimateMessagesContextTokens(candidates) <= softLimitTokens) {
      return { status: 'noop', reason: 'not_enough_messages' }
    }

    const compactCount = candidates.length - MIN_MESSAGES_TO_KEEP_LIVE
    const compactableMessages = candidates.slice(0, compactCount)

    if (compactableMessages.length < MIN_MESSAGES_TO_COMPACT) {
      return { status: 'noop', reason: existingState ? 'already_compact' : 'not_enough_messages' }
    }

    const model = await getCompactionModel(assistant)
    const provider = getProviderByModel(model)

    if (!hasApiKey(provider)) {
      return {
        status: 'error',
        reason: 'summary_failed',
        message: 'Quick model provider API key is not configured.'
      }
    }

    const chunkTargetTokens = Math.max(
      CHUNK_MIN_TOKENS,
      Math.min(CHUNK_MAX_TOKENS, Math.floor(hardLimitTokens * CHUNK_TARGET_RATIO))
    )

    const chunkPlans = buildChunkPlans(compactableMessages, chunkTargetTokens)
    if (!chunkPlans.length) {
      return { status: 'noop', reason: 'already_compact' }
    }

    const newSegments: ConversationCompactionSegment[] = []

    for (const plan of chunkPlans) {
      const summary = await summarizeChunk(model, plan.messages)
      if (!summary) {
        logger.error('Conversation compaction summary generation returned empty result', {
          topicId,
          chunkSize: plan.messages.length,
          modelId: model.id
        })
        return { status: 'error', reason: 'summary_failed' }
      }

      newSegments.push(buildSegment(plan.messages, summary, model, plan.overlapMessageCount))
    }

    const segments = [...(existingState?.segments || []), ...newSegments]
    const lastCompactedMessageId = compactableMessages[compactableMessages.length - 1].id
    const lastCompactedMessageIndex = activeMessages.findIndex((message) => message.id === lastCompactedMessageId)
    const compactedMessages = activeMessages.slice(0, lastCompactedMessageIndex + 1)

    const state: ConversationCompactionState = {
      version: CONVERSATION_COMPACTION_VERSION,
      updatedAt: new Date().toISOString(),
      maxContextTokens,
      softLimitTokens,
      hardLimitTokens,
      compactedMessageCount: compactedMessages.length,
      sourceTokenEstimate: estimateMessagesContextTokens(compactedMessages),
      summaryTokenEstimate: segments.reduce((acc, segment) => acc + segment.summaryTokenEstimate, 0),
      lastCompactedMessageId,
      segments
    }

    await dbService.saveCompactionState(topicId, state)

    return {
      status: 'success',
      state,
      addedSegments: newSegments.length,
      compactedMessageCount: compactedMessages.length
    }
  }

  /**
   * Best-effort automatic compaction helper.
   *
   * - Never throws (caller should treat `undefined` as "skipped").
   * - De-dupes concurrent auto compaction per topic.
   * - Applies a cooldown after errors to avoid repeated failing retries (e.g. missing API keys).
   *
   * Note: Manual compaction buttons should call `compactConversation()` directly so users can
   * retry immediately after configuration changes.
   */
  static async autoCompactConversation({
    topicId,
    assistant,
    messages
  }: {
    topicId: string
    assistant: Assistant
    messages: Message[]
  }): Promise<CompactConversationResult | undefined> {
    const { maxContextTokens } = getAssistantSettings(assistant)
    // If users explicitly configured "Unlimited" context, do not auto-compact.
    // (Manual compaction remains available via UI action.)
    if (maxContextTokens >= UNLIMITED_MAX_CONTEXT_TOKENS) {
      return undefined
    }

    const now = Date.now()
    const cooldownUntil = ConversationCompactionService.autoCompactionCooldownUntil.get(topicId)
    if (cooldownUntil && cooldownUntil > now) {
      return undefined
    }

    if (ConversationCompactionService.autoCompactionInFlightTopics.has(topicId)) {
      return undefined
    }

    ConversationCompactionService.autoCompactionInFlightTopics.add(topicId)
    try {
      const result = await ConversationCompactionService.compactConversation({ topicId, assistant, messages })

      if (result.status === 'error') {
        ConversationCompactionService.autoCompactionCooldownUntil.set(topicId, now + AUTO_COMPACTION_ERROR_COOLDOWN_MS)
      }

      return result
    } catch (error) {
      logger.error('Auto conversation compaction failed unexpectedly', { topicId, error: error as Error })
      ConversationCompactionService.autoCompactionCooldownUntil.set(topicId, now + AUTO_COMPACTION_ERROR_COOLDOWN_MS)
      return undefined
    } finally {
      ConversationCompactionService.autoCompactionInFlightTopics.delete(topicId)
    }
  }
}
