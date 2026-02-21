import { loggerService } from '@logger'
import type { Middleware } from '@reduxjs/toolkit'
import ConversationThreadService from '@renderer/services/ConversationThreadService'
import type { Topic } from '@renderer/types'
import { REHYDRATE } from 'redux-persist'

import type { RootState } from './index'

const logger = loggerService.withContext('ConversationThreadSyncMiddleware')

const ACTION_TYPES = {
  addAssistant: 'assistants/addAssistant',
  addTopic: 'assistants/addTopic',
  removeAllTopics: 'assistants/removeAllTopics',
  removeAssistant: 'assistants/removeAssistant',
  removeTopic: 'assistants/removeTopic',
  restoreTrashedTopic: 'assistants/restoreTrashedTopic',
  trashTopic: 'assistants/trashTopic',
  updateAssistant: 'assistants/updateAssistant',
  updateAssistants: 'assistants/updateAssistants',
  updateTopic: 'assistants/updateTopic',
  updateTopicUpdatedAt: 'assistants/updateTopicUpdatedAt',
  updateTopics: 'assistants/updateTopics'
} as const

type AnyReduxAction = {
  type?: string
  payload?: any
}

function runSyncTask(task: Promise<void>, context: string): void {
  void task.catch((error) => {
    logger.warn('Failed to sync conversation threads (non-fatal):', {
      context,
      error: (error as Error)?.message
    })
  })
}

function findHomeTopicById(state: RootState, topicId: string): { assistantId: string; topic: Topic } | null {
  for (const assistant of state.assistants.assistants) {
    for (const topic of assistant.topics || []) {
      if (topic.id === topicId) {
        return {
          assistantId: assistant.id,
          topic
        }
      }
    }
  }

  return null
}

export const conversationThreadSyncMiddleware: Middleware<{}, RootState> =
  ({ getState }) =>
  (next) =>
  (action) => {
    const result = next(action)

    const normalizedAction = action as AnyReduxAction
    const actionType = normalizedAction.type
    const payload = normalizedAction.payload

    if (actionType === REHYDRATE) {
      runSyncTask(ConversationThreadService.reconcileHomeThreads(getState().assistants.assistants), 'rehydrate')
      return result
    }

    if (actionType === ACTION_TYPES.updateAssistants && Array.isArray(payload)) {
      runSyncTask(ConversationThreadService.reconcileHomeThreads(payload), 'updateAssistants')
      return result
    }

    if (actionType === ACTION_TYPES.addAssistant && payload?.id) {
      runSyncTask(
        ConversationThreadService.upsertHomeTopics({
          assistantId: payload.id,
          topics: payload.topics || []
        }),
        'addAssistant'
      )
      return result
    }

    if (actionType === ACTION_TYPES.removeAssistant && typeof payload?.id === 'string') {
      runSyncTask(ConversationThreadService.removeHomeThreadsByAssistantId(payload.id), 'removeAssistant')
      return result
    }

    if (actionType === ACTION_TYPES.addTopic && payload?.assistantId && payload?.topic) {
      runSyncTask(ConversationThreadService.upsertHomeTopic(payload), 'addTopic')
      return result
    }

    if (actionType === ACTION_TYPES.updateTopic && payload?.assistantId && payload?.topic) {
      runSyncTask(ConversationThreadService.upsertHomeTopic(payload), 'updateTopic')
      return result
    }

    if (actionType === ACTION_TYPES.updateTopics && payload?.assistantId && Array.isArray(payload?.topics)) {
      runSyncTask(
        ConversationThreadService.replaceHomeTopicsForAssistant({
          assistantId: payload.assistantId,
          topics: payload.topics
        }),
        'updateTopics'
      )
      return result
    }

    if (actionType === ACTION_TYPES.removeTopic && payload?.topic?.id) {
      runSyncTask(ConversationThreadService.removeHomeTopic(payload.topic.id), 'removeTopic')
      return result
    }

    if (actionType === ACTION_TYPES.trashTopic && payload?.topic?.id) {
      runSyncTask(ConversationThreadService.removeHomeTopic(payload.topic.id), 'trashTopic')
      return result
    }

    if (actionType === ACTION_TYPES.restoreTrashedTopic && payload?.assistantId && payload?.topic) {
      runSyncTask(ConversationThreadService.upsertHomeTopic(payload), 'restoreTrashedTopic')
      return result
    }

    if (actionType === ACTION_TYPES.removeAllTopics && typeof payload?.assistantId === 'string') {
      const assistant = getState().assistants.assistants.find((item) => item.id === payload.assistantId)
      if (assistant) {
        runSyncTask(
          ConversationThreadService.replaceHomeTopicsForAssistant({
            assistantId: assistant.id,
            topics: assistant.topics || []
          }),
          'removeAllTopics'
        )
      }
      return result
    }

    if (actionType === ACTION_TYPES.updateTopicUpdatedAt && typeof payload?.topicId === 'string') {
      runSyncTask(
        (async () => {
          const touched = await ConversationThreadService.touchHomeTopic({ topicId: payload.topicId })
          if (touched) return

          const currentState = getState()
          const found = findHomeTopicById(currentState, payload.topicId)
          if (found) {
            await ConversationThreadService.upsertHomeTopic(found)
          }
        })(),
        'updateTopicUpdatedAt'
      )
      return result
    }

    if (actionType === ACTION_TYPES.updateAssistant && payload?.id && Array.isArray(payload?.topics)) {
      runSyncTask(
        ConversationThreadService.replaceHomeTopicsForAssistant({
          assistantId: payload.id,
          topics: payload.topics
        }),
        'updateAssistant.topics'
      )
    }

    return result
  }

export default conversationThreadSyncMiddleware
