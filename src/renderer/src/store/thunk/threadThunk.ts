import { loggerService } from '@logger'
import { getAssistantById } from '@renderer/services/AssistantService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { buildThreadTopicId } from '@renderer/services/ThreadService'
import type { AppDispatch, RootState } from '@renderer/store'
import { selectMessagesForTopic } from '@renderer/store/newMessage'
import type { Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import type { ThreadAnchor, ThreadSummary } from '@renderer/types/thread'
import { uuid } from '@renderer/utils'

import { getUserMessage } from '../../services/MessagesService'
import {
  clearTopicMessagesThunk,
  cloneMessagesToNewTopicThunk,
  sendMessage,
  updateMessageAndBlocksThunk
} from './messageThunk'

const logger = loggerService.withContext('threadThunk')

export type CreateThreadArgs = {
  parentTopicId: string
  parentMessageId: string
  assistantId: string
  starterPrompt: string
  anchor?: ThreadAnchor
  highlightedText?: string
}

export const createThreadFromMessageThunk =
  ({ parentTopicId, parentMessageId, assistantId, starterPrompt, anchor, highlightedText }: CreateThreadArgs) =>
  async (dispatch: AppDispatch, getState: () => RootState): Promise<ThreadSummary | null> => {
    try {
      const state = getState()
      const parentMessages = selectMessagesForTopic(state, parentTopicId)
      const parentIndex = parentMessages.findIndex((m) => m.id === parentMessageId)
      if (parentIndex === -1) {
        logger.error('Parent message not found in topic', { parentTopicId, parentMessageId })
        return null
      }

      const contextCount = parentIndex + 1
      const threadId = uuid()
      const threadTopicId = buildThreadTopicId({ parentTopicId, parentMessageId, threadId })
      const now = new Date().toISOString()

      const summary: ThreadSummary = {
        id: threadId,
        topicId: threadTopicId,
        createdAt: now,
        updatedAt: now,
        starterPrompt,
        contextCount,
        anchor
      }

      const parentMessageEntity = state.messages.entities[parentMessageId]
      const existingThreads = (parentMessageEntity?.threads ?? []).slice()
      existingThreads.push(summary)

      await dispatch(
        updateMessageAndBlocksThunk(
          parentTopicId,
          { id: parentMessageId, threads: existingThreads, updatedAt: now } as Partial<Message> & Pick<Message, 'id'>,
          []
        )
      )

      // Create a synthetic topic object for cloning/sending. We intentionally do NOT add it to the assistant topic list
      // (threads are hidden from the sidebar).
      const threadTopic: Topic = {
        id: threadTopicId,
        assistantId,
        name: 'Thread',
        createdAt: now,
        updatedAt: now,
        messages: []
      }

      const cloneSuccess = await dispatch(cloneMessagesToNewTopicThunk(parentTopicId, contextCount, threadTopic) as any)
      if (!cloneSuccess) {
        logger.error('Failed to clone context into thread topic', { parentTopicId, threadTopicId })
        return null
      }

      const assistant = getAssistantById(assistantId)
      if (!assistant) {
        logger.error('Assistant not found while creating thread', { assistantId })
        return null
      }

      // Clone to avoid accidentally mutating a Redux-owned object downstream.
      const assistantCopy = { ...assistant }

      const highlight = highlightedText?.trim()
      const highlightExcerpt = highlight ? highlight.slice(0, 1200) : ''
      const contentWithHighlight = highlightExcerpt
        ? [
            `Highlighted excerpt from the parent message:`,
            ...highlightExcerpt.split('\n').map((l) => `> ${l}`),
            ``,
            `User prompt:`,
            starterPrompt
          ].join('\n')
        : starterPrompt

      const { message, blocks } = getUserMessage({
        assistant: assistantCopy,
        topic: threadTopic,
        content: contentWithHighlight
      })
      await dispatch(sendMessage(message, blocks, assistantCopy, threadTopicId))

      // Ask the parent message UI to open the panel for this new thread.
      EventEmitter.emit(EVENT_NAMES.OPEN_THREAD_PANEL, {
        parentMessageId,
        threadTopicId,
        focusComposer: true
      })

      return summary
    } catch (error) {
      logger.error('Failed to create thread:', error as Error)
      return null
    }
  }

export type DeleteThreadArgs = {
  parentTopicId: string
  parentMessageId: string
  threadTopicId: string
}

export const deleteThreadThunk =
  ({ parentTopicId, parentMessageId, threadTopicId }: DeleteThreadArgs) =>
  async (dispatch: AppDispatch, getState: () => RootState): Promise<boolean> => {
    try {
      const state = getState()
      const parentMessageEntity = state.messages.entities[parentMessageId] as Message | undefined
      const existingThreads = (parentMessageEntity?.threads ?? []) as ThreadSummary[]

      const nextThreads = existingThreads.filter((th) => th.topicId !== threadTopicId)
      const now = new Date().toISOString()

      await dispatch(
        updateMessageAndBlocksThunk(
          parentTopicId,
          { id: parentMessageId, threads: nextThreads, updatedAt: now } as Partial<Message> & Pick<Message, 'id'>,
          []
        )
      )

      // Wipe thread messages + blocks + files.
      await dispatch(clearTopicMessagesThunk(threadTopicId) as any)

      // Best-effort: remove the hidden topic record entirely (thread topics are Dexie-backed).
      // We keep this best-effort and non-fatal to avoid breaking deletion if storage changes.
      try {
        // Lazy import to keep main chunk smaller and avoid hard dependency in other environments.
        const mod = await import('@renderer/databases')
        const db = mod.default
        await db.topics.delete(threadTopicId)
      } catch (error) {
        logger.warn('Failed to delete thread topic record from DB (non-fatal):', error as Error)
      }

      // Clean up scroll position cache if present.
      try {
        window.keyv.remove(`scroll:topic-${threadTopicId}`)
      } catch {
        // ignore
      }

      return true
    } catch (error) {
      logger.error('Failed to delete thread:', error as Error)
      return false
    }
  }
