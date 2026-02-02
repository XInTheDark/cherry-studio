import { loggerService } from '@logger'
import { db } from '@renderer/databases'
import i18n from '@renderer/i18n'
import store from '@renderer/store'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { clearTrash, removeTrashedTopic, restoreTrashedTopic, trashTopic } from '@renderer/store/assistants'
import type { Topic, TrashedTopic } from '@renderer/types'
import { useCallback, useMemo, useRef } from 'react'

import { selectTrashEvictions, TRASH_MAX_TOPICS } from './trashUtils'
import { TopicManager } from './useTopic'

const logger = loggerService.withContext('useTrash')

export function useTrash() {
  const dispatch = useAppDispatch()

  const trashedTopics = useAppSelector((state) => (state.assistants.trashedTopics || []) as TrashedTopic[])
  const assistants = useAppSelector((state) => state.assistants.assistants)

  const trashedTopicsSorted = useMemo(() => {
    return [...trashedTopics].sort((a, b) => b.trashedAt.localeCompare(a.trashedAt))
  }, [trashedTopics])

  // Prevent concurrent trimming (e.g. deleting multiple topics quickly).
  const trimmingRef = useRef(false)

  const trimTrashToMax = useCallback(async (): Promise<number> => {
    if (trimmingRef.current) {
      return 0
    }

    trimmingRef.current = true
    try {
      const state = store.getState()
      const current = ((state.assistants as any).trashedTopics || []) as TrashedTopic[]
      const evictions = selectTrashEvictions(current, TRASH_MAX_TOPICS)
      if (evictions.length === 0) {
        return 0
      }

      for (const item of evictions) {
        try {
          await TopicManager.removeTopic(item.id)
        } catch (error) {
          // Best-effort: keep trimming the rest. If deletion fails, we still remove from metadata
          // to avoid a growing trash list, but we log the error for diagnosis.
          logger.warn('Failed to permanently delete evicted trashed topic (best-effort):', error as Error)
        } finally {
          dispatch(removeTrashedTopic({ id: item.id }))
        }
      }

      return evictions.length
    } finally {
      trimmingRef.current = false
    }
  }, [dispatch])

  const moveTopicToTrash = useCallback(
    async (assistantId: string, topic: Topic): Promise<void> => {
      const now = new Date().toISOString()
      dispatch(trashTopic({ assistantId, topic, trashedAt: now }))

      const purged = await trimTrashToMax()
      if (purged > 0) {
        window.toast?.info(i18n.t('chat.trash.auto_purge', { count: purged }))
      }
    },
    [dispatch, trimTrashToMax]
  )

  const restoreFromTrash = useCallback(
    async (topicId: string): Promise<boolean> => {
      const state = store.getState()
      const current = ((state.assistants as any).trashedTopics || []) as TrashedTopic[]
      const entry = current.find((t) => t.id === topicId)
      if (!entry) {
        return false
      }

      // If the original assistant no longer exists, restore into the first assistant.
      const originalAssistantExists = assistants.some((a) => a.id === entry.assistantId)
      const targetAssistantId = originalAssistantExists ? entry.assistantId : assistants[0]?.id

      if (!targetAssistantId) {
        window.toast?.error(i18n.t('chat.trash.restore.error_no_assistant'))
        return false
      }

      if (!originalAssistantExists) {
        window.toast?.warning(i18n.t('chat.trash.restore.warning_fallback_assistant'))
      }

      try {
        const dbTopic = await db.topics.get(topicId)
        if (!dbTopic) {
          // Topic is missing from Dexie (likely auto-purged earlier). Remove stale entry.
          dispatch(removeTrashedTopic({ id: topicId }))
          window.toast?.error(i18n.t('chat.trash.restore.error_missing_data'))
          return false
        }

        // If we restore into a different assistant, align message assistantId with the topic owner.
        if (targetAssistantId !== entry.assistantId) {
          await db.topics
            .where('id')
            .equals(topicId)
            .modify((topic) => {
              if (topic.messages) {
                topic.messages = topic.messages.map((m) => ({ ...m, assistantId: targetAssistantId }))
              }
            })
        }

        const restoredTopic: Topic = { ...(entry.topic as any), assistantId: targetAssistantId, messages: [] }
        dispatch(restoreTrashedTopic({ assistantId: targetAssistantId, topic: restoredTopic }))

        window.toast?.success(i18n.t('chat.trash.restore.success'))
        return true
      } catch (error) {
        logger.error('Failed to restore topic from trash:', error as Error)
        window.toast?.error(i18n.t('chat.trash.restore.error_generic'))
        return false
      }
    },
    [assistants, dispatch]
  )

  const deletePermanently = useCallback(
    async (topicId: string): Promise<boolean> => {
      try {
        await TopicManager.removeTopic(topicId)
        dispatch(removeTrashedTopic({ id: topicId }))
        window.toast?.success(i18n.t('chat.trash.delete.success'))
        return true
      } catch (error) {
        logger.error('Failed to permanently delete trashed topic:', error as Error)
        window.toast?.error(i18n.t('chat.trash.delete.error'))
        return false
      }
    },
    [dispatch]
  )

  const emptyTrash = useCallback(async (): Promise<boolean> => {
    const state = store.getState()
    const current = ((state.assistants as any).trashedTopics || []) as TrashedTopic[]
    if (current.length === 0) {
      return true
    }

    try {
      for (const item of current) {
        try {
          await TopicManager.removeTopic(item.id)
        } catch (error) {
          logger.warn('Failed to permanently delete topic while emptying trash (best-effort):', error as Error)
        }
      }

      dispatch(clearTrash())
      window.toast?.success(i18n.t('chat.trash.empty.success', { count: current.length }))
      return true
    } catch (error) {
      logger.error('Failed to empty trash:', error as Error)
      window.toast?.error(i18n.t('chat.trash.empty.error'))
      return false
    }
  }, [dispatch])

  return {
    trashedTopics: trashedTopicsSorted,
    moveTopicToTrash,
    restoreFromTrash,
    deletePermanently,
    emptyTrash
  }
}
