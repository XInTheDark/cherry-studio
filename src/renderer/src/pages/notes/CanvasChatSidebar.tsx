import { loggerService } from '@logger'
import { useAssistant } from '@renderer/hooks/useAssistant'
import CanvasChatService, {
  type CanvasChatEntryV1,
  type CanvasChatsIndexV1
} from '@renderer/services/CanvasChatService'
import CanvasHistoryService from '@renderer/services/CanvasHistoryService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { loadTopicMessagesThunk } from '@renderer/store/thunk/messageThunk'
import type { Topic } from '@renderer/types'
import { Button, Divider, Empty, Select, Space, Tooltip, Typography } from 'antd'
import dayjs from 'dayjs'
import { Plus, X } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import Inputbar from '../home/Inputbar/Inputbar'
import Messages from '../home/Messages/Messages'

const logger = loggerService.withContext('CanvasChatSidebar')

type Props = {
  open: boolean
  notesPath: string
  filePath: string
  width?: number
  onClose: () => void
}

const CanvasChatSidebar: FC<Props> = ({ open, notesPath, filePath, width = 380, onClose }) => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const assistants = useAppSelector((s) => s.assistants.assistants)
  const defaultAssistantId = useAppSelector((s) => s.assistants.defaultAssistant?.id) as string

  const [panelWidth, setPanelWidth] = useState(width)
  const resizingRef = useRef<{ startX: number; startWidth: number; pointerId: number } | null>(null)

  const [loading, setLoading] = useState(false)
  const [canvasId, setCanvasId] = useState<string>('')
  const [index, setIndex] = useState<CanvasChatsIndexV1 | null>(null)
  const [activeChatId, setActiveChatId] = useState<string | null>(null)

  const activeChat: CanvasChatEntryV1 | null = useMemo(() => {
    if (!index) return null
    if (!index.chats.length) return null
    const id = activeChatId ?? index.lastActiveChatId ?? index.chats[0]?.id
    return index.chats.find((c) => c.id === id) ?? index.chats[0] ?? null
  }, [activeChatId, index])

  const assistantOptions = useMemo(
    () =>
      assistants.map((a) => ({
        label: a.name,
        value: a.id
      })),
    [assistants]
  )

  const load = useCallback(async () => {
    if (!open || !notesPath || !filePath) return

    setLoading(true)
    setIndex(null)
    setActiveChatId(null)
    try {
      const { canvasId } = await CanvasHistoryService.getCanvasId({ notesPath, filePath })
      setCanvasId(canvasId)

      const preferredAssistantId = defaultAssistantId || assistants[0]?.id
      if (!preferredAssistantId) {
        throw new Error('No assistants available for canvas chat')
      }

      const { index, activeChat } = await CanvasChatService.ensureAtLeastOneChat({
        canvasId,
        defaultAssistantId: preferredAssistantId
      })
      setIndex(index)
      setActiveChatId(activeChat.id)
    } catch (error) {
      logger.error('Failed to load canvas chats:', error as Error)
      window.toast?.error?.(t('notes.chat.load_failed'))
    } finally {
      setLoading(false)
    }
  }, [assistants, defaultAssistantId, filePath, notesPath, open, t])

  useEffect(() => {
    void load()
  }, [load])

  // Persist last active chat id.
  useEffect(() => {
    if (!canvasId || !activeChat?.id) return
    CanvasChatService.setLastActiveChat({ canvasId, chatId: activeChat.id }).catch((error) => {
      logger.warn('Failed to persist last active chat:', error as Error)
    })
  }, [activeChat?.id, canvasId])

  const refreshIndex = useCallback(async () => {
    if (!canvasId) return
    const next = await CanvasChatService.listChats(canvasId)
    setIndex(next)
  }, [canvasId])

  const handleNewChat = useCallback(
    async (assistantId: string) => {
      if (!canvasId) return
      const created = await CanvasChatService.createChat({ canvasId, assistantId })
      await refreshIndex()
      setActiveChatId(created.id)
    },
    [canvasId, refreshIndex]
  )

  if (!open) return null

  if (!notesPath || !filePath) {
    return (
      <Container style={{ width: panelWidth }}>
        <HeaderRow>
          <Title>{t('notes.chat.title')}</Title>
          <Button size="small" type="text" icon={<X size={16} />} onClick={onClose} />
        </HeaderRow>
        <Divider style={{ margin: '8px 0' }} />
        <Empty description={t('notes.chat.no_active_canvas')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      </Container>
    )
  }

  return (
    <Container style={{ width: panelWidth }}>
      <ResizeHandle
        onPointerDown={(e) => {
          resizingRef.current = { startX: e.clientX, startWidth: panelWidth, pointerId: e.pointerId }
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

      <HeaderRow>
        <Title>{t('notes.chat.title')}</Title>
        <Button size="small" type="text" icon={<X size={16} />} onClick={onClose} />
      </HeaderRow>

      <Divider style={{ margin: '8px 0' }} />

      <Space direction="vertical" style={{ width: '100%' }} size={8}>
        <Space align="center" style={{ width: '100%', justifyContent: 'space-between' }}>
          <Select
            style={{ flex: 1 }}
            size="small"
            value={activeChat?.assistantId}
            placeholder={t('notes.chat.select_assistant')}
            options={assistantOptions}
            onChange={(assistantId) => {
              // Requirement: switching assistant starts a NEW chat thread.
              void handleNewChat(assistantId)
            }}
          />
          <Tooltip title={t('notes.chat.new_chat')}>
            <Button
              size="small"
              icon={<Plus size={16} />}
              onClick={() => {
                const assistantId = activeChat?.assistantId || defaultAssistantId || assistants[0]?.id
                if (!assistantId) return
                void handleNewChat(assistantId)
              }}
            />
          </Tooltip>
        </Space>

        <ChatLayout>
          <ChatList>
            {!index?.chats?.length ? (
              <Empty description={t('notes.chat.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              index.chats.map((c) => {
                const isActive = c.id === activeChat?.id
                const title = c.name?.trim() || CanvasChatService.getAssistantName(c.assistantId)
                const time = dayjs(c.updatedAt ?? c.createdAt).format('MM/DD HH:mm')
                return (
                  <ChatListItem
                    key={c.id}
                    role="button"
                    tabIndex={0}
                    $active={isActive}
                    onClick={() => setActiveChatId(c.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setActiveChatId(c.id)
                      }
                    }}>
                    <Typography.Text style={{ display: 'block' }} ellipsis={{ tooltip: title }}>
                      {title}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {time}
                    </Typography.Text>
                  </ChatListItem>
                )
              })
            )}
          </ChatList>

          <ChatView>
            {activeChat ? (
              <CanvasChatView
                assistantId={activeChat.assistantId}
                topicId={activeChat.topicId}
                containerId={`canvas-chat-${canvasId}-${activeChat.id}`}
                loading={loading}
                dispatch={dispatch}
              />
            ) : (
              <Empty description={t('notes.chat.no_active_chat')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
          </ChatView>
        </ChatLayout>
      </Space>
    </Container>
  )
}

const CanvasChatView: FC<{
  assistantId: string
  topicId: string
  containerId: string
  loading: boolean
  dispatch: ReturnType<typeof useAppDispatch>
}> = ({ assistantId, topicId, containerId, loading, dispatch }) => {
  const { t } = useTranslation()
  const { assistant } = useAssistant(assistantId)

  // Ensure messages are loaded from DB into the store.
  useEffect(() => {
    if (!topicId) return
    dispatch(loadTopicMessagesThunk(topicId) as any)
  }, [dispatch, topicId])

  const topic: Topic = useMemo(() => {
    const now = new Date().toISOString()
    return {
      id: topicId,
      assistantId,
      name: t('notes.chat.topic_name'),
      createdAt: now,
      updatedAt: now,
      messages: []
    }
  }, [assistantId, t, topicId])

  if (!assistant) {
    return <Empty description={t('common.loading')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
  }

  return (
    <ChatViewInner>
      <Messages
        assistant={assistant}
        topic={topic}
        setActiveTopic={() => {}}
        enableGlobalEvents={false}
        enableShortcuts={false}
        chatContextOptions={{ setActiveTopic: false, enableMultiSelect: false }}
        hidePrompt={true}
        containerId={containerId}
        emptyHint={loading ? t('common.loading') : t('notes.chat.empty_hint')}
      />
      <Inputbar assistant={assistant} setActiveTopic={() => {}} topic={topic} draftCacheKey={`inputbar:${topicId}`} />
    </ChatViewInner>
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

const HeaderRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
`

const Title = styled.div`
  font-weight: 600;
  color: var(--color-text);
`

const ChatLayout = styled.div`
  display: flex;
  gap: 10px;
  min-height: 0;
  flex: 1;
  min-width: 0;
`

const ChatList = styled.div`
  flex: 0 0 160px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: auto;
  padding-right: 4px;
`

const ChatListItem = styled.div<{ $active: boolean }>`
  border: 1px solid ${({ $active }) => ($active ? 'var(--color-primary)' : 'var(--color-border-soft)')};
  background: ${({ $active }) => ($active ? 'var(--color-primary-soft)' : 'var(--color-background-soft)')};
  border-radius: 10px;
  padding: 8px 10px;
  cursor: pointer;
  &:hover {
    border-color: var(--color-border);
  }
`

const ChatView = styled.div`
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
`

const ChatViewInner = styled.div`
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
`

export default CanvasChatSidebar
