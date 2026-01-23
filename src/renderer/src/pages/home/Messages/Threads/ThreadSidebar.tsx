import { loggerService } from '@logger'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useTopicMessages } from '@renderer/hooks/useMessageOperations'
import Inputbar from '@renderer/pages/home/Inputbar/Inputbar'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { parseThreadTopicId } from '@renderer/services/ThreadService'
import store, { useAppDispatch, useAppSelector } from '@renderer/store'
import { loadTopicMessagesThunk } from '@renderer/store/thunk/messageThunk'
import { createThreadFromMessageThunk } from '@renderer/store/thunk/threadThunk'
import type { Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import type { ThreadAnchor, ThreadSummary } from '@renderer/types/thread'
import { getMainTextContent } from '@renderer/utils/messageUtils/find'
import { Button, Divider } from 'antd'
import dayjs from 'dayjs'
import { ChevronLeft, X } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import MessageContent from '../MessageContent'
import Messages from '../Messages'
import ThreadStarterInputbar from './ThreadStarterInputbar'

const logger = loggerService.withContext('ThreadSidebar')

type OpenPayload = {
  parentTopicId?: string
  assistantId?: string
  parentMessageId: string
  threadTopicId?: string
  focusComposer?: boolean
  draft?: string
  anchor?: ThreadAnchor
  selectedText?: string
}

type ThreadRoute =
  | {
      type: 'messageThreads'
      parentTopicId: string
      assistantId: string
      parentMessageId: string
      focusComposer?: boolean
      draft?: string
      anchor?: ThreadAnchor
      selectedText?: string
    }
  | {
      type: 'threadChat'
      parentTopicId: string
      assistantId: string
      parentMessageId: string
      threadTopicId: string
    }

type Props = {
  // Used only for sizing/clamping; sidebar is docked, not a floating popup.
  width?: number
}

const ThreadSidebar: FC<Props> = ({ width = 380 }) => {
  const { t } = useTranslation()

  const [panelWidth, setPanelWidth] = useState(width)
  const resizingRef = useRef<{
    startX: number
    startWidth: number
    pointerId: number
  } | null>(null)

  const [open, setOpen] = useState(false)
  const [stack, setStack] = useState<ThreadRoute[]>([])

  const activeRoute = stack.at(-1) ?? null

  const close = useCallback(() => {
    setOpen(false)
    setStack([])
  }, [])

  const pop = useCallback(() => {
    setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev))
  }, [])

  const push = useCallback((route: ThreadRoute) => {
    setStack((prev) => [...prev, route])
  }, [])

  // Open requests are emitted from:
  // - Message "N threads" click
  // - Message menubar "new thread"
  // - Highlight span click
  // - Selection + typing (comment-style)
  useEffect(() => {
    const unsubscribe = EventEmitter.on(EVENT_NAMES.OPEN_THREAD_PANEL, (payload: OpenPayload) => {
      if (!payload?.parentMessageId) return
      setOpen(true)

      const state = store.getState()
      const msg = state.messages.entities[payload.parentMessageId] as Message | undefined
      const assistantId = payload.assistantId ?? msg?.assistantId ?? ''

      setStack((prev) => {
        const base = prev.length > 0 ? prev : []

        if (payload.threadTopicId) {
          const parsed = parseThreadTopicId(payload.threadTopicId)
          const parentTopicId = parsed?.parentTopicId ?? payload.parentTopicId ?? msg?.topicId ?? ''
          const parentMessageId = parsed?.parentMessageId ?? payload.parentMessageId

          // If we're already on this thread chat, keep stack as-is.
          const top = base.at(-1)
          if (top?.type === 'threadChat' && top.threadTopicId === payload.threadTopicId) {
            return base
          }

          const listRoute: ThreadRoute = { type: 'messageThreads', parentTopicId, assistantId, parentMessageId }
          const chatRoute: ThreadRoute = {
            type: 'threadChat',
            parentTopicId,
            assistantId,
            parentMessageId,
            threadTopicId: payload.threadTopicId
          }

          // Stack: push list -> chat so Back behaves like Discord threads.
          return [...base, listRoute, chatRoute]
        }

        const parentTopicId = payload.parentTopicId ?? msg?.topicId ?? ''
        const nextListRoute: ThreadRoute = {
          type: 'messageThreads',
          parentTopicId,
          assistantId,
          parentMessageId: payload.parentMessageId,
          focusComposer: payload.focusComposer,
          draft: payload.draft,
          anchor: payload.anchor,
          selectedText: payload.selectedText
        }

        const top = base.at(-1)
        if (
          top?.type === 'messageThreads' &&
          top.parentTopicId === nextListRoute.parentTopicId &&
          top.parentMessageId === nextListRoute.parentMessageId
        ) {
          // Update current view (e.g. focus composer / attach selection anchor).
          return [...base.slice(0, -1), nextListRoute]
        }

        return [...base, nextListRoute]
      })
    })
    return () => unsubscribe()
  }, [])

  // If the sidebar is closed, render nothing (and don’t steal layout width).
  if (!open || !activeRoute) {
    return null
  }

  return (
    <Container style={{ width: panelWidth }}>
      <ResizeHandle
        onPointerDown={(e) => {
          // Left-edge handle: moving left increases width; moving right decreases.
          resizingRef.current = {
            startX: e.clientX,
            startWidth: panelWidth,
            pointerId: e.pointerId
          }
          try {
            ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
          } catch {
            // ignore
          }
          document.body.style.userSelect = 'none'
        }}
        onPointerMove={(e) => {
          const r = resizingRef.current
          if (!r || r.pointerId !== e.pointerId) return
          const delta = r.startX - e.clientX
          const next = Math.max(320, Math.min(720, r.startWidth + delta))
          setPanelWidth(next)
        }}
        onPointerUp={(e) => {
          const r = resizingRef.current
          if (!r || r.pointerId !== e.pointerId) return
          resizingRef.current = null
          document.body.style.userSelect = ''
          try {
            ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
          } catch {
            // ignore
          }
        }}
      />
      <Header>
        {stack.length > 1 ? (
          <Button size="small" type="text" icon={<ChevronLeft size={16} />} onClick={pop}>
            {t('thread.back')}
          </Button>
        ) : (
          <Title>{t('thread.title')}</Title>
        )}

        <Button size="small" type="text" icon={<X size={16} />} onClick={close} />
      </Header>

      <Divider style={{ margin: '8px 0' }} />

      {activeRoute.type === 'messageThreads' && (
        <MessageThreadsView
          parentTopicId={activeRoute.parentTopicId}
          assistantId={activeRoute.assistantId}
          parentMessageId={activeRoute.parentMessageId}
          focusComposer={activeRoute.focusComposer}
          draft={activeRoute.draft}
          anchor={activeRoute.anchor}
          selectedText={activeRoute.selectedText}
          onOpenThread={(threadTopicId) => {
            push({
              type: 'threadChat',
              parentTopicId: activeRoute.parentTopicId,
              assistantId: activeRoute.assistantId,
              parentMessageId: activeRoute.parentMessageId,
              threadTopicId
            })
          }}
        />
      )}

      {activeRoute.type === 'threadChat' && (
        <ThreadChatView
          parentTopicId={activeRoute.parentTopicId}
          assistantId={activeRoute.assistantId}
          parentMessageId={activeRoute.parentMessageId}
          threadTopicId={activeRoute.threadTopicId}
        />
      )}
    </Container>
  )
}

const MessageThreadsView: FC<{
  parentTopicId: string
  assistantId: string
  parentMessageId: string
  focusComposer?: boolean
  draft?: string
  anchor?: ThreadAnchor
  selectedText?: string
  onOpenThread: (threadTopicId: string) => void
}> = ({ parentTopicId, assistantId, parentMessageId, focusComposer, draft, anchor, selectedText, onOpenThread }) => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()

  const messageEntity = useAppSelector((s) => s.messages.entities[parentMessageId]) as Message | undefined
  const threads = (messageEntity?.threads ?? []) as ThreadSummary[]
  const handleCreate = useCallback(
    async (content: string) => {
      const trimmed = content.trim()
      if (!trimmed) return

      if (!parentTopicId || !assistantId) {
        logger.error('Missing parentTopicId/assistantId for thread create', { parentTopicId, assistantId })
        window.toast?.error?.(t('thread.create_failed'))
        return
      }

      const summary = await dispatch(
        createThreadFromMessageThunk({
          parentTopicId,
          parentMessageId,
          assistantId,
          starterPrompt: trimmed,
          anchor
        }) as any
      )

      if (!summary?.topicId) {
        window.toast?.error?.(t('thread.create_failed'))
        return
      }

      onOpenThread(summary.topicId)
    },
    [anchor, assistantId, dispatch, onOpenThread, parentMessageId, parentTopicId, t]
  )

  return (
    <div>
      {selectedText?.trim() ? (
        <SelectedText title={selectedText}>{selectedText}</SelectedText>
      ) : (
        <HintText>{t('thread.start')}</HintText>
      )}

      <ThreadStarterInputbar
        parentTopicId={parentTopicId}
        parentMessageId={parentMessageId}
        placeholder={t('thread.start_placeholder')}
        focusComposer={focusComposer}
        draft={draft}
        onSend={handleCreate}
      />

      <Divider style={{ margin: '12px 0' }} />

      <ThreadList>
        {threads.map((th) => (
          <ThreadListItem key={th.id} onClick={() => onOpenThread(th.topicId)}>
            <ThreadPrompt title={th.starterPrompt}>{th.starterPrompt}</ThreadPrompt>
            <ThreadMeta>{dayjs(th.updatedAt ?? th.createdAt).format('MM/DD HH:mm')}</ThreadMeta>
          </ThreadListItem>
        ))}
      </ThreadList>
    </div>
  )
}

const ThreadChatView: FC<{
  parentTopicId: string
  assistantId: string
  parentMessageId: string
  threadTopicId: string
}> = ({ parentTopicId, assistantId, parentMessageId, threadTopicId }) => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()

  // Ensure the thread topic messages are loaded from DB into the store.
  useEffect(() => {
    dispatch(loadTopicMessagesThunk(threadTopicId) as any)
  }, [dispatch, threadTopicId])

  const parentMessage = useAppSelector((s) => s.messages.entities[parentMessageId]) as Message | undefined
  const parentTopicName = useMemo(() => {
    const assistants = store.getState().assistants.assistants
    const topics = assistants.flatMap((a) => a.topics)
    return topics.find((t) => t.id === parentTopicId)?.name ?? ''
  }, [parentTopicId])

  const containerId = useMemo(() => `messages-thread-${threadTopicId}`, [threadTopicId])
  const [parentCollapsed, setParentCollapsed] = useState(false)

  useEffect(() => {
    let cancelled = false
    let detach: (() => void) | undefined

    const attach = () => {
      if (cancelled) return
      const el = document.getElementById(containerId)
      if (!el) {
        setTimeout(attach, 50)
        return
      }

      const onScroll = () => {
        // In this app's inverted message list, scrollTop === 0 means "at bottom / latest".
        // Collapse as soon as the user moves away from the bottom.
        setParentCollapsed(el.scrollTop > 0)
      }

      const onWheel = (e: WheelEvent) => {
        // On macOS, "rubberband" scrolling can fire wheel events even when scrollTop doesn't change.
        // This makes the collapse feel responsive even for short threads.
        if (el.scrollTop !== 0) return
        if (e.deltaY > 0) setParentCollapsed(true)
        if (e.deltaY < 0) setParentCollapsed(false)
      }

      el.addEventListener('scroll', onScroll)
      el.addEventListener('wheel', onWheel, { passive: true })
      onScroll()
      detach = () => {
        el.removeEventListener('scroll', onScroll)
        el.removeEventListener('wheel', onWheel)
      }
    }

    attach()
    return () => {
      cancelled = true
      detach?.()
    }
  }, [containerId])

  const threadSummary = useMemo(() => {
    const threads = (parentMessage?.threads ?? []) as ThreadSummary[]
    return threads.find((th) => th.topicId === threadTopicId) ?? null
  }, [parentMessage?.threads, threadTopicId])

  const contextCount = threadSummary?.contextCount ?? 0
  const starterPrompt = threadSummary?.starterPrompt ?? ''
  const parentSnippet = useMemo(() => (parentMessage ? getMainTextContent(parentMessage).trim() : ''), [parentMessage])
  const parentLabel = useMemo(
    () => (parentTopicName ? t('thread.on_topic', { name: parentTopicName }) : t('thread.on_message')),
    [parentTopicName, t]
  )

  const { assistant } = useAssistant(assistantId)

  const now = useMemo(() => new Date().toISOString(), [])

  const threadTopic: Topic | null = useMemo(() => {
    if (!assistant) return null
    return {
      id: threadTopicId,
      assistantId: assistant.id,
      name: t('thread.title'),
      createdAt: now,
      updatedAt: now,
      messages: []
    }
  }, [assistant, now, t, threadTopicId])

  // Messages are loaded separately; this is mostly for showing title/empty state.
  const threadMessages = useTopicMessages(threadTopicId)
  const visibleCount = Math.max(0, threadMessages.length - contextCount)

  if (!assistant || !threadTopic) {
    return <EmptyState>{t('common.loading')}</EmptyState>
  }

  return (
    <ThreadChatContainer>
      {parentMessage && (
        <ParentMessageCard $collapsed={parentCollapsed}>
          {!parentCollapsed ? (
            <ParentMessageTitle>{parentLabel}</ParentMessageTitle>
          ) : (
            <ParentMessageCollapsedLine title={`${parentLabel} — ${parentSnippet}`}>
              <ParentMessageCollapsedLabel>{parentLabel}</ParentMessageCollapsedLabel>
              <ParentMessageCollapsedSep> — </ParentMessageCollapsedSep>
              <ParentMessageCollapsedSnippet>{parentSnippet}</ParentMessageCollapsedSnippet>
            </ParentMessageCollapsedLine>
          )}
          {!parentCollapsed ? (
            <ParentMessageBody>
              <MessageContent message={parentMessage} />
            </ParentMessageBody>
          ) : null}
        </ParentMessageCard>
      )}
      {starterPrompt?.trim() ? <ThreadHeaderTitle title={starterPrompt}>{starterPrompt}</ThreadHeaderTitle> : null}
      <ThreadChatBody>
        <Messages
          assistant={assistant}
          topic={threadTopic}
          setActiveTopic={() => {}}
          enableGlobalEvents={false}
          enableShortcuts={false}
          chatContextOptions={{ setActiveTopic: false, enableMultiSelect: false }}
          skipLeadingMessages={contextCount}
          hidePrompt={true}
          emptyHint={visibleCount === 0 ? t('thread.reply_placeholder') : undefined}
          containerId={containerId}
        />
        <Inputbar
          assistant={assistant}
          setActiveTopic={() => {}}
          topic={threadTopic}
          draftCacheKey={`inputbar-draft:thread:${threadTopicId}`}
        />
      </ThreadChatBody>
    </ThreadChatContainer>
  )
}

const Container = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  border-left: 1px solid var(--color-border-soft);
  background: var(--color-background);
  padding: 10px;
  position: relative;
`

const ResizeHandle = styled.div`
  position: absolute;
  left: -4px;
  top: 0;
  bottom: 0;
  width: 8px;
  cursor: col-resize;
  z-index: 10;
  touch-action: none;
`

const Header = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
`

const Title = styled.div`
  font-weight: 600;
  color: var(--color-text);
`

const HintText = styled.div`
  font-size: 12px;
  color: var(--color-text-3);
  margin-bottom: 8px;
`

const SelectedText = styled.div`
  font-size: 12px;
  color: var(--color-text-2);
  background: var(--color-background-soft);
  border-radius: 8px;
  padding: 8px;
  margin-bottom: 8px;
  max-height: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
`

const ThreadList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`

const ThreadListItem = styled.button`
  border: 1px solid var(--color-border-soft);
  background: var(--color-background-soft);
  border-radius: 10px;
  padding: 10px;
  text-align: left;
  cursor: pointer;
  &:hover {
    border-color: var(--color-border);
  }
`

const ThreadPrompt = styled.div`
  font-size: 13px;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`

const ThreadMeta = styled.div`
  margin-top: 6px;
  font-size: 12px;
  color: var(--color-text-3);
`

const ThreadChatContainer = styled.div`
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
`

const ThreadChatBody = styled.div`
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
`

const ThreadHeaderTitle = styled.div`
  font-weight: 600;
  font-size: 13px;
  color: var(--color-text);
  margin: 0 0 8px 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`

const ParentMessageCard = styled.div<{ $collapsed: boolean }>`
  border: 1px solid var(--color-border-soft);
  background: var(--color-background-soft);
  border-radius: 10px;
  padding: ${({ $collapsed }) => ($collapsed ? '6px 10px' : '10px')};
  margin-bottom: ${({ $collapsed }) => ($collapsed ? '6px' : '10px')};
  transition: padding 0.15s ease, margin-bottom 0.15s ease;
`

const ParentMessageTitle = styled.div`
  font-size: 12px;
  color: var(--color-text-3);
  margin-bottom: 6px;
`

const ParentMessageBody = styled.div`
  max-height: 160px;
  overflow: hidden;
  mask-image: linear-gradient(to bottom, rgba(0, 0, 0, 1), rgba(0, 0, 0, 0));
`

const ParentMessageCollapsedLine = styled.div`
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 1;
  overflow: hidden;
  line-height: 1.35;
  font-size: 12px;
  color: var(--color-text);
`

const ParentMessageCollapsedLabel = styled.span`
  color: var(--color-text-2);
  font-weight: 500;
`

const ParentMessageCollapsedSep = styled.span`
  color: var(--color-text-3);
`

const ParentMessageCollapsedSnippet = styled.span`
  color: var(--color-text);
`

const EmptyState = styled.div`
  padding: 12px;
  color: var(--color-text-3);
  font-size: 13px;
`

export default ThreadSidebar
