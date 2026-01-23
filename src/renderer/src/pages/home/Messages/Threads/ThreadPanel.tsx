import { loggerService } from '@logger'
import { useTopicMessages } from '@renderer/hooks/useMessageOperations'
import { getUserMessage } from '@renderer/services/MessagesService'
import { useAppDispatch } from '@renderer/store'
import { loadTopicMessagesThunk, sendMessage, updateMessageAndBlocksThunk } from '@renderer/store/thunk/messageThunk'
import { createThreadFromMessageThunk } from '@renderer/store/thunk/threadThunk'
import type { Assistant, Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import type { ThreadSummary } from '@renderer/types/thread'
import { Button, Divider, Input } from 'antd'
import type { TextAreaRef } from 'antd/es/input/TextArea'
import dayjs from 'dayjs'
import { ChevronLeft, X } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import MessageItem from '../Message'

const logger = loggerService.withContext('ThreadPanel')

type Props = {
  assistant: Assistant
  parentTopic: Topic
  parentMessage: Message
  initialThreadTopicId?: string
  focusComposer?: boolean
  onClose: () => void
}

const ThreadPanel: FC<Props> = ({
  assistant,
  parentTopic,
  parentMessage,
  initialThreadTopicId,
  focusComposer,
  onClose
}) => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const threads = useMemo(() => parentMessage.threads ?? [], [parentMessage.threads])

  const [activeThreadTopicId, setActiveThreadTopicId] = useState<string | null>(initialThreadTopicId ?? null)
  const [draftNewThread, setDraftNewThread] = useState('')
  const [draftReply, setDraftReply] = useState('')

  const replyInputRef = useRef<TextAreaRef | null>(null)
  const newThreadInputRef = useRef<TextAreaRef | null>(null)

  useEffect(() => {
    if (initialThreadTopicId) {
      setActiveThreadTopicId(initialThreadTopicId)
    }
  }, [initialThreadTopicId])

  const activeThread = useMemo(
    () => (activeThreadTopicId ? (threads.find((th) => th.topicId === activeThreadTopicId) ?? null) : null),
    [activeThreadTopicId, threads]
  )

  const threadTopic: Topic | null = useMemo(() => {
    if (!activeThreadTopicId) return null
    const now = new Date().toISOString()
    return {
      id: activeThreadTopicId,
      assistantId: assistant.id,
      name: t('thread.title'),
      createdAt: now,
      updatedAt: now,
      messages: []
    }
  }, [activeThreadTopicId, assistant.id, t])

  useEffect(() => {
    if (!activeThreadTopicId) return
    dispatch(loadTopicMessagesThunk(activeThreadTopicId))
  }, [activeThreadTopicId, dispatch])

  const threadMessages = useTopicMessages(activeThreadTopicId ?? '')

  const visibleThreadMessages = useMemo(() => {
    if (!activeThreadTopicId) return []
    const ctx = activeThread?.contextCount ?? 0
    return ctx > 0 ? threadMessages.slice(ctx) : threadMessages
  }, [activeThread, activeThreadTopicId, threadMessages])

  const updateThreadUpdatedAt = useCallback(
    async (threadId: string) => {
      const now = new Date().toISOString()
      const nextThreads: ThreadSummary[] = (parentMessage.threads ?? []).map((th) =>
        th.id === threadId ? { ...th, updatedAt: now } : th
      )
      await dispatch(updateMessageAndBlocksThunk(parentTopic.id, { id: parentMessage.id, threads: nextThreads }, []))
    },
    [dispatch, parentMessage.id, parentMessage.threads, parentTopic.id]
  )

  const handleCreateNewThread = useCallback(async () => {
    const starterPrompt = draftNewThread.trim()
    if (!starterPrompt) return

    const summary = await dispatch(
      createThreadFromMessageThunk({
        parentTopicId: parentTopic.id,
        parentMessageId: parentMessage.id,
        assistantId: assistant.id,
        starterPrompt
      }) as any
    )

    if (summary?.topicId) {
      setDraftNewThread('')
      setActiveThreadTopicId(summary.topicId)
    }
  }, [assistant.id, dispatch, draftNewThread, parentMessage.id, parentTopic.id])

  const handleReply = useCallback(async () => {
    if (!activeThread || !threadTopic) return
    const content = draftReply.trim()
    if (!content) return

    try {
      const { message, blocks } = getUserMessage({ assistant, topic: threadTopic, content })
      await dispatch(sendMessage(message, blocks, assistant, threadTopic.id) as any)
      setDraftReply('')
      await updateThreadUpdatedAt(activeThread.id)
    } catch (error) {
      logger.error('Failed to send thread reply:', error as Error)
    }
  }, [activeThread, assistant, dispatch, draftReply, threadTopic, updateThreadUpdatedAt])

  useEffect(() => {
    if (!focusComposer) return
    // Focus whichever composer is currently visible.
    setTimeout(() => {
      if (activeThreadTopicId) {
        replyInputRef.current?.focus()
      } else {
        newThreadInputRef.current?.focus()
      }
    }, 0)
  }, [activeThreadTopicId, focusComposer])

  const onKeyDownCreate = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleCreateNewThread()
      }
    },
    [handleCreateNewThread]
  )

  const onKeyDownReply = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleReply()
      }
    },
    [handleReply]
  )

  return (
    <Container>
      <Header>
        {activeThreadTopicId ? (
          <Button
            size="small"
            type="text"
            icon={<ChevronLeft size={16} />}
            onClick={() => setActiveThreadTopicId(null)}>
            {t('thread.back')}
          </Button>
        ) : (
          <Title>{t('thread.title')}</Title>
        )}

        <Button size="small" type="text" icon={<X size={16} />} onClick={onClose} />
      </Header>

      <Divider style={{ margin: '8px 0' }} />

      {!activeThreadTopicId && (
        <>
          <ComposerLabel>{t('thread.start')}</ComposerLabel>
          <Input.TextArea
            ref={(el) => {
              newThreadInputRef.current = el
            }}
            value={draftNewThread}
            onChange={(e) => setDraftNewThread(e.target.value)}
            placeholder={t('thread.start_placeholder')}
            autoSize={{ minRows: 2, maxRows: 6 }}
            onKeyDown={onKeyDownCreate}
          />
          <Actions>
            <Button type="primary" size="small" disabled={!draftNewThread.trim()} onClick={handleCreateNewThread}>
              {t('thread.send')}
            </Button>
          </Actions>

          <Divider style={{ margin: '12px 0' }} />

          <ThreadList>
            {(threads ?? []).map((th) => (
              <ThreadListItem key={th.id} onClick={() => setActiveThreadTopicId(th.topicId)}>
                <ThreadPrompt title={th.starterPrompt}>{th.starterPrompt}</ThreadPrompt>
                <ThreadMeta>{dayjs(th.updatedAt ?? th.createdAt).format('MM/DD HH:mm')}</ThreadMeta>
              </ThreadListItem>
            ))}
          </ThreadList>
        </>
      )}

      {activeThreadTopicId && threadTopic && activeThread && (
        <>
          <ThreadHeaderTitle title={activeThread.starterPrompt}>{activeThread.starterPrompt}</ThreadHeaderTitle>
          <ThreadMessages>
            {visibleThreadMessages.map((m, idx) => (
              <ThreadMessageWrapper key={m.id}>
                <MessageItem
                  message={m}
                  topic={threadTopic}
                  index={idx}
                  hideMenuBar={false}
                  chatContextOptions={{ setActiveTopic: false, enableMultiSelect: false }}
                />
              </ThreadMessageWrapper>
            ))}
          </ThreadMessages>
          <Divider style={{ margin: '10px 0' }} />
          <ComposerLabel>{t('thread.reply')}</ComposerLabel>
          <Input.TextArea
            ref={(el) => {
              replyInputRef.current = el
            }}
            value={draftReply}
            onChange={(e) => setDraftReply(e.target.value)}
            placeholder={t('thread.reply_placeholder')}
            autoSize={{ minRows: 2, maxRows: 6 }}
            onKeyDown={onKeyDownReply}
          />
          <Actions>
            <Button type="primary" size="small" disabled={!draftReply.trim()} onClick={handleReply}>
              {t('thread.send')}
            </Button>
          </Actions>
        </>
      )}
    </Container>
  )
}

const Container = styled.div`
  width: 100%;
  border: 1px solid var(--color-border-soft);
  background: var(--color-background-soft);
  border-radius: 10px;
  padding: 10px;
  margin-left: 46px;
  margin-top: 8px;
`

const Header = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
`

const Title = styled.div`
  font-weight: 600;
  color: var(--color-text);
`

const ComposerLabel = styled.div`
  font-size: 12px;
  color: var(--color-text-3);
  margin-bottom: 6px;
`

const Actions = styled.div`
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
`

const ThreadList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`

const ThreadListItem = styled.div`
  cursor: pointer;
  padding: 8px;
  border-radius: 8px;
  background: var(--color-background-mute);
  display: flex;
  justify-content: space-between;
  gap: 10px;

  &:hover {
    background: var(--color-background);
  }
`

const ThreadPrompt = styled.div`
  flex: 1;
  font-size: 13px;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const ThreadMeta = styled.div`
  font-size: 12px;
  color: var(--color-text-3);
  white-space: nowrap;
`

const ThreadHeaderTitle = styled.div`
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
  margin-bottom: 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const ThreadMessages = styled.div`
  max-height: 320px;
  overflow: auto;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.03);
  padding: 6px 6px 0 6px;
`

const ThreadMessageWrapper = styled.div`
  margin-bottom: 8px;
`

export default ThreadPanel
