import { loggerService } from '@logger'
import { convertMessagesToSdkMessages } from '@renderer/aiCore/prepareParams'
import type { Assistant, Message } from '@renderer/types'
import type { ModelMessage } from 'ai'
import { findLast, isEmpty } from 'lodash'

import { getAssistantSettings, getDefaultModel } from './AssistantService'
import { filterMessagesPipelineByTokens } from './ContextWindowService'

const logger = loggerService.withContext('ConversationService')

export class ConversationService {
  /**
   * Applies the filtering pipeline that prepares UI messages for model consumption.
   * This keeps the logic testable and prevents future regressions when the pipeline changes.
   */
  static filterMessagesPipeline(
    messages: Message[],
    maxContextTokens: number,
    options?: {
      /**
       * When true, keep trailing assistant messages (used by \"continue\" where the context may end with assistant output).
       */
      allowTrailingAssistant?: boolean
    }
  ): Message[] {
    return filterMessagesPipelineByTokens(messages, maxContextTokens, options)
  }

  static async prepareMessagesForModel(
    messages: Message[],
    assistant: Assistant,
    options?: {
      /**
       * When true, keep trailing assistant messages in the preparation pipeline.
       */
      allowTrailingAssistant?: boolean
    }
  ): Promise<{ modelMessages: ModelMessage[]; uiMessages: Message[] }> {
    const { maxContextTokens } = getAssistantSettings(assistant)
    const lastUserMessage = findLast(messages, (m) => m.role === 'user')
    if (!lastUserMessage) {
      return {
        modelMessages: [],
        uiMessages: []
      }
    }

    const { ConversationCompactionService } = await import('./ConversationCompactionService')
    const compactionContext = await ConversationCompactionService.resolveContextWindow({
      topicId: lastUserMessage.topicId,
      messages,
      maxContextTokens
    })

    const uiMessagesFromPipeline = ConversationService.filterMessagesPipeline(
      compactionContext.liveMessages,
      compactionContext.adjustedMaxContextTokens,
      options
    )
    logger.debug('uiMessagesFromPipeline', uiMessagesFromPipeline)

    // Fallback: ensure at least the last user message is present to avoid empty payloads
    let uiMessages = uiMessagesFromPipeline
    const fallbackLastUser = findLast(compactionContext.liveMessages, (m) => m.role === 'user') || lastUserMessage
    if ((!uiMessages || uiMessages.length === 0) && fallbackLastUser) {
      uiMessages = [fallbackLastUser]
    }

    const liveModelMessages = await convertMessagesToSdkMessages(uiMessages, assistant.model || getDefaultModel())

    return {
      modelMessages: [...compactionContext.summaryMessages, ...liveModelMessages],
      uiMessages
    }
  }

  static needsWebSearch(assistant: Assistant): boolean {
    return !!assistant.webSearchProviderId
  }

  static needsKnowledgeSearch(assistant: Assistant): boolean {
    return !isEmpty(assistant.knowledge_bases)
  }
}
