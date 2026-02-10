import { CONTEXT_HARD_SAFETY_MARGIN_TOKENS, UNLIMITED_MAX_CONTEXT_TOKENS } from '@renderer/config/constant'
import { FileTypes } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import {
  filterAdjacentUserMessaegs,
  filterAfterContextClearMessages,
  filterEmptyMessages,
  filterErrorOnlyMessagesWithRelated,
  filterLastAssistantMessage,
  filterUsefulMessages,
  filterUserRoleStartMessages
} from '@renderer/utils/messageUtils/filters'
import {
  findToolBlocks,
  getCitationContent,
  getFileContent,
  getMainTextContent,
  getThinkingContent
} from '@renderer/utils/messageUtils/find'
import { approximateTokenSize } from 'tokenx'

const MESSAGE_OVERHEAD_TOKENS = 12
const TOOL_SNIPPET_MAX_CHARS = 6000

function truncateText(value: string | undefined, limit: number): string {
  if (!value || value.length <= limit) {
    return value ?? ''
  }

  return `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]`
}

function estimateFileTokens(message: Message): number {
  const files = getFileContent(message)

  return files.reduce((acc, file) => {
    if (!file) {
      return acc
    }

    if (file.type === FileTypes.IMAGE) {
      return acc + Math.max(1, Math.floor((file.size || 0) / 100))
    }

    // Text/doc files are represented by metadata here. Use a conservative estimate from file size.
    const sizeBasedEstimate = file.size ? Math.ceil(file.size / 4) : 0
    const nameEstimate = approximateTokenSize(file.origin_name || file.name || '')

    return acc + Math.max(16, sizeBasedEstimate, nameEstimate)
  }, 0)
}

function estimateToolTokens(message: Message): number {
  const toolBlocks = findToolBlocks(message)
  if (!toolBlocks.length) {
    return 0
  }

  const snippets = toolBlocks
    .map((block) => {
      const response = (block as any)?.metadata?.rawMcpToolResponse
      if (!response) {
        return ''
      }

      return JSON.stringify({
        toolName: response.tool?.name || response.toolName,
        status: response.status,
        args: truncateText(
          typeof response.arguments === 'string' ? response.arguments : JSON.stringify(response.arguments),
          TOOL_SNIPPET_MAX_CHARS
        ),
        response: truncateText(
          typeof response.response === 'string' ? response.response : JSON.stringify(response.response),
          TOOL_SNIPPET_MAX_CHARS
        )
      })
    })
    .filter(Boolean)

  return snippets.length > 0 ? approximateTokenSize(snippets.join('\n')) : 0
}

export function estimateMessageContextTokens(message: Message): number {
  const textContent = [getMainTextContent(message), getThinkingContent(message), getCitationContent(message)]
    .filter(Boolean)
    .join('\n\n')

  return (
    approximateTokenSize(textContent) +
    estimateFileTokens(message) +
    estimateToolTokens(message) +
    MESSAGE_OVERHEAD_TOKENS
  )
}

export function estimateMessagesContextTokens(messages: Message[]): number {
  return messages.reduce((acc, message) => acc + estimateMessageContextTokens(message), 0)
}

export function normalizeMaxContextTokens(maxContextTokens: number): number {
  if (maxContextTokens >= UNLIMITED_MAX_CONTEXT_TOKENS) {
    return Number.MAX_SAFE_INTEGER
  }

  return Math.max(1, maxContextTokens)
}

function limitMessagesByTokenBudget(messages: Message[], maxContextTokens: number): Message[] {
  if (messages.length === 0) {
    return []
  }

  const normalizedMax = normalizeMaxContextTokens(maxContextTokens)
  if (!Number.isFinite(normalizedMax) || normalizedMax === Number.MAX_SAFE_INTEGER) {
    return messages
  }

  const budget = Math.max(1, normalizedMax - CONTEXT_HARD_SAFETY_MARGIN_TOKENS)
  const selected: Message[] = []
  let used = 0

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    const messageTokens = estimateMessageContextTokens(message)

    if (selected.length === 0) {
      selected.push(message)
      used += messageTokens
      continue
    }

    if (used + messageTokens > budget) {
      continue
    }

    selected.push(message)
    used += messageTokens
  }

  return selected.reverse()
}

export function filterMessagesPipelineByTokens(
  messages: Message[],
  maxContextTokens: number,
  options?: {
    allowTrailingAssistant?: boolean
  }
): Message[] {
  const messagesAfterContextClear = filterAfterContextClearMessages(messages)
  const usefulMessages = filterUsefulMessages(messagesAfterContextClear)
  const withoutErrorOnlyPairs = filterErrorOnlyMessagesWithRelated(usefulMessages)
  const withoutTrailingAssistant = options?.allowTrailingAssistant
    ? withoutErrorOnlyPairs
    : filterLastAssistantMessage(withoutErrorOnlyPairs)
  const withoutAdjacentUsers = filterAdjacentUserMessaegs(withoutTrailingAssistant)
  const limitedByTokens = limitMessagesByTokenBudget(withoutAdjacentUsers, maxContextTokens)
  const contextClearFiltered = filterAfterContextClearMessages(limitedByTokens)
  const nonEmptyMessages = filterEmptyMessages(contextClearFiltered)

  return filterUserRoleStartMessages(nonEmptyMessages)
}
