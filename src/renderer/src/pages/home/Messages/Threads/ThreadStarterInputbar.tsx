import { loggerService } from '@logger'
import { useAssistant } from '@renderer/hooks/useAssistant'
import Inputbar, { type InputbarController } from '@renderer/pages/home/Inputbar/Inputbar'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { type Topic, TopicType } from '@renderer/types'
import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('ThreadStarterInputbar')

type Props = {
  assistantId: string
  parentTopicId: string
  parentMessageId: string
  placeholder: string
  focusComposer?: boolean
  draft?: string
  onSend: (content: string) => Promise<void>
}

const ThreadStarterInputbar: FC<Props> = ({
  assistantId,
  parentTopicId,
  parentMessageId,
  placeholder,
  focusComposer,
  draft,
  onSend
}) => {
  const { t } = useTranslation()
  const { assistant } = useAssistant(assistantId)
  const controllerRef = useRef<InputbarController | null>(null)

  // Keep drafts isolated per parent message so navigating between threads doesn't overwrite user input.
  const draftCacheKey = useMemo(
    () => `inputbar-draft:thread-starter:${parentTopicId}:${parentMessageId}`,
    [parentMessageId, parentTopicId]
  )

  const now = useMemo(() => new Date().toISOString(), [])
  const parentTopic = useMemo<Topic | null>(() => {
    if (!assistant) return null

    const existing = assistant.topics.find((topic) => topic.id === parentTopicId)
    if (existing) {
      return existing
    }

    return {
      id: parentTopicId,
      assistantId: assistant.id,
      name: t('thread.title'),
      type: TopicType.Chat,
      createdAt: now,
      updatedAt: now,
      messages: []
    }
  }, [assistant, now, parentTopicId, t])

  const focusToEnd = useCallback(() => {
    requestAnimationFrame(() => controllerRef.current?.focusToEnd())
  }, [])

  const handleControllerChange = useCallback(
    (controller: InputbarController | null) => {
      controllerRef.current = controller
      if (!controller) return

      if (typeof draft === 'string') {
        controller.setText((prev) => (prev ? prev : draft))
      }

      if (focusComposer) {
        requestAnimationFrame(() => controller.focusToEnd())
      }
    },
    [draft, focusComposer]
  )

  // Apply seeded draft updates while preserving existing user edits.
  useEffect(() => {
    if (typeof draft !== 'string') return
    controllerRef.current?.setText((prev) => (prev ? prev : draft))
  }, [draft])

  useEffect(() => {
    if (!focusComposer) return
    focusToEnd()
  }, [focusComposer, focusToEnd])

  // Buffer keystrokes during the focus transition (so the first characters don't get "lost").
  useEffect(() => {
    const unsubscribe = EventEmitter.on(
      EVENT_NAMES.THREAD_STARTER_APPEND_DRAFT,
      (payload: { parentTopicId: string; parentMessageId: string; key: string }) => {
        if (payload.parentTopicId !== parentTopicId) return
        if (payload.parentMessageId !== parentMessageId) return

        controllerRef.current?.setText((prev) => prev + payload.key)
        focusToEnd()
      }
    )
    return () => unsubscribe()
  }, [focusToEnd, parentMessageId, parentTopicId])

  const handleSendText = useCallback(
    async (content: string) => {
      await onSend(content)
    },
    [onSend]
  )

  const handleSendError = useCallback(
    (error: unknown) => {
      logger.error('Failed to create thread:', error as Error)
      window.toast?.error?.(t('thread.create_failed'))
    },
    [t]
  )

  if (!assistant || !parentTopic) {
    return null
  }

  return (
    <Inputbar
      assistant={assistant}
      setActiveTopic={() => {}}
      topic={parentTopic}
      draftCacheKey={draftCacheKey}
      placeholder={placeholder}
      autoFocus={Boolean(focusComposer)}
      onSendText={handleSendText}
      onSendError={handleSendError}
      onControllerChange={handleControllerChange}
    />
  )
}

export default ThreadStarterInputbar
