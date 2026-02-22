import { loggerService } from '@logger'
import { CopyIcon, DeleteIcon, EditIcon } from '@renderer/components/Icons'
import PromptPopup from '@renderer/components/Popups/PromptPopup'
import db from '@renderer/databases'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { fetchMessagesSummary } from '@renderer/services/ApiService'
import CanvasChatService, {
  type CanvasChatEntryV1,
  type CanvasChatsIndexV1,
  parseCanvasChatTopicId
} from '@renderer/services/CanvasChatService'
import CanvasCommentService from '@renderer/services/CanvasCommentService'
import CanvasHistoryService from '@renderer/services/CanvasHistoryService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { getUserMessage } from '@renderer/services/MessagesService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { clearTopicMessagesThunk, loadTopicMessagesThunk } from '@renderer/store/thunk/messageThunk'
import { sendMessage as sendMessageThunk } from '@renderer/store/thunk/messageThunk'
import type { CanvasCommentEntry, CanvasCommentsIndexV1, Topic } from '@renderer/types'
import { copyTopicAsJson, copyTopicAsMarkdown, copyTopicAsPlainText } from '@renderer/utils/copy'
import type { MenuProps } from 'antd'
import { Button, Divider, Dropdown, Empty, Select, Tag, Tooltip, Typography } from 'antd'
import dayjs from 'dayjs'
import {
  BrushCleaning,
  MessageCircle,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Sparkles,
  X
} from 'lucide-react'
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
  getCurrentSelection?: () => { text: string; startOffset?: number; endOffset?: number } | null
  getCurrentMarkdown?: () => string
}

const CanvasChatSidebar: FC<Props> = ({
  open,
  notesPath,
  filePath,
  width = 380,
  onClose,
  getCurrentSelection,
  getCurrentMarkdown
}) => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const assistants = useAppSelector((s) => s.assistants.assistants)
  const defaultAssistantId = useAppSelector((s) => s.assistants.defaultAssistant?.id) as string

  const [panelWidth, setPanelWidth] = useState(width)
  const resizingRef = useRef<{ startX: number; startWidth: number; pointerId: number } | null>(null)

  const [loading, setLoading] = useState(false)
  const [creatingChat, setCreatingChat] = useState(false)
  const [canvasId, setCanvasId] = useState<string>('')
  const [index, setIndex] = useState<CanvasChatsIndexV1 | null>(null)
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [isChatListVisible, setIsChatListVisible] = useState(true)
  const [activeView, setActiveView] = useState<'chat' | 'comments'>('chat')
  const [commentsIndex, setCommentsIndex] = useState<CanvasCommentsIndexV1 | null>(null)
  const [commentsLoading, setCommentsLoading] = useState(false)

  const autoRenameLocksRef = useRef<Set<string>>(new Set())

  const shouldStackChatList = panelWidth < 620 || (index?.chats?.length ?? 0) <= 1

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

  const getChatTitle = useCallback((chat: CanvasChatEntryV1) => {
    return chat.name?.trim() || CanvasChatService.getAssistantName(chat.assistantId)
  }, [])

  const buildChatTopic = useCallback(
    (chat: CanvasChatEntryV1): Topic => ({
      id: chat.topicId,
      assistantId: chat.assistantId,
      name: getChatTitle(chat),
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      messages: []
    }),
    [getChatTitle]
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

  const refreshComments = useCallback(async () => {
    if (!canvasId) {
      setCommentsIndex(null)
      return
    }
    setCommentsLoading(true)
    try {
      const next = await CanvasCommentService.listComments(canvasId)
      setCommentsIndex(next)
    } catch (error) {
      logger.error('Failed to load canvas comments:', error as Error)
      window.toast?.error?.(t('notes.comments.load_failed'))
    } finally {
      setCommentsLoading(false)
    }
  }, [canvasId, t])

  useEffect(() => {
    void refreshComments()
  }, [refreshComments])

  const sendMessageToActiveCanvasChat = useCallback(
    async (content: string) => {
      const trimmed = content.trim()
      if (!trimmed || !activeChat) return
      const assistant = assistants.find((item) => item.id === activeChat.assistantId)
      if (!assistant) {
        throw new Error(`Assistant not found for canvas chat: ${activeChat.assistantId}`)
      }

      const topic = buildChatTopic(activeChat)
      const { message, blocks } = getUserMessage({
        assistant,
        topic,
        content: trimmed
      })
      dispatch(sendMessageThunk(message, blocks, assistant, topic.id) as any)
    },
    [activeChat, assistants, buildChatTopic, dispatch]
  )

  const handleAutoRenameChat = useCallback(
    async (chat: CanvasChatEntryV1) => {
      const assistant = assistants.find((a) => a.id === chat.assistantId)
      if (!assistant) return

      try {
        await dispatch(loadTopicMessagesThunk(chat.topicId, true) as any)
        const topic = await db.topics.get(chat.topicId)
        const messages = topic?.messages || []

        if (messages.length === 0) {
          return
        }

        const summaryText = await fetchMessagesSummary({ messages, assistant })
        const nextName = summaryText?.trim()
        if (!nextName) return

        await CanvasChatService.renameChat({
          canvasId,
          chatId: chat.id,
          name: nextName,
          isNameManuallyEdited: false
        })
        await refreshIndex()
      } catch (error) {
        logger.warn('Failed to auto rename canvas chat:', error as Error)
      }
    },
    [assistants, canvasId, dispatch, refreshIndex]
  )

  const handleRenameChat = useCallback(
    async (chat: CanvasChatEntryV1) => {
      const nextName = await PromptPopup.show({
        title: t('common.rename'),
        message: '',
        defaultValue: getChatTitle(chat)
      })

      if (nextName === null) return

      try {
        await CanvasChatService.renameChat({
          canvasId,
          chatId: chat.id,
          name: nextName,
          isNameManuallyEdited: true
        })
        await refreshIndex()
      } catch (error) {
        logger.error('Failed to rename canvas chat:', error as Error)
        window.toast?.error?.(t('common.errors.validation'))
      }
    },
    [canvasId, getChatTitle, refreshIndex, t]
  )

  const handleClearChatMessages = useCallback(
    async (chat: CanvasChatEntryV1) => {
      try {
        await dispatch(clearTopicMessagesThunk(chat.topicId) as any)
        await CanvasChatService.touchChat({ canvasId, chatId: chat.id })
        await refreshIndex()
      } catch (error) {
        logger.error('Failed to clear canvas chat messages:', error as Error)
        window.toast?.error?.(t('common.delete_failed'))
      }
    },
    [canvasId, dispatch, refreshIndex, t]
  )

  const performDeleteChat = useCallback(
    async (chat: CanvasChatEntryV1) => {
      if (!canvasId) return

      try {
        const result = await CanvasChatService.deleteChat({ canvasId, chatId: chat.id, removeTopic: true })
        setIndex(result.index)
        setActiveChatId(result.activeChatId)
      } catch (error) {
        logger.error('Failed to delete canvas chat:', error as Error)
        window.toast?.error?.(t('common.delete_failed'))
      }
    },
    [canvasId, t]
  )

  const handleDeleteChat = useCallback(
    (chat: CanvasChatEntryV1) => {
      window.modal.confirm({
        title: t('common.delete'),
        content: t('common.delete_confirm'),
        centered: true,
        onOk: async () => performDeleteChat(chat)
      })
    },
    [performDeleteChat, t]
  )

  const handleCopyChatAsJson = useCallback(
    async (chat: CanvasChatEntryV1) => {
      await copyTopicAsJson(buildChatTopic(chat))
    },
    [buildChatTopic]
  )

  const handleCopyChatAsMarkdown = useCallback(
    async (chat: CanvasChatEntryV1) => {
      await copyTopicAsMarkdown(buildChatTopic(chat))
    },
    [buildChatTopic]
  )

  const handleCopyChatAsPlainText = useCallback(
    async (chat: CanvasChatEntryV1) => {
      await copyTopicAsPlainText(buildChatTopic(chat))
    },
    [buildChatTopic]
  )

  const buildChatMenuItems = useCallback(
    (chat: CanvasChatEntryV1): MenuProps['items'] => [
      {
        label: t('chat.topics.auto_rename'),
        key: 'auto-rename',
        icon: <Sparkles size={14} />,
        onClick: () => {
          void handleAutoRenameChat(chat)
        }
      },
      {
        label: t('common.rename'),
        key: 'rename',
        icon: <EditIcon size={14} />,
        onClick: () => {
          void handleRenameChat(chat)
        }
      },
      {
        label: t('chat.topics.copy.title'),
        key: 'copy',
        icon: <CopyIcon size={14} />,
        children: [
          {
            label: t('chat.topics.copy.json'),
            key: 'copy-json',
            onClick: () => {
              void handleCopyChatAsJson(chat)
            }
          },
          {
            label: t('chat.topics.copy.md'),
            key: 'copy-md',
            onClick: () => {
              void handleCopyChatAsMarkdown(chat)
            }
          },
          {
            label: t('chat.topics.copy.plain_text'),
            key: 'copy-plain-text',
            onClick: () => {
              void handleCopyChatAsPlainText(chat)
            }
          }
        ]
      },
      {
        label: t('chat.topics.clear.title'),
        key: 'clear',
        icon: <BrushCleaning size={14} />,
        disabled: chat.origin === 'main-chat' || chat.origin === 'thread',
        onClick: () => {
          void handleClearChatMessages(chat)
        }
      },
      { type: 'divider' },
      {
        label: t('common.delete'),
        key: 'delete',
        danger: true,
        disabled: (index?.chats.length ?? 0) <= 1,
        icon: <DeleteIcon size={14} className="lucide-custom" />,
        onClick: () => {
          handleDeleteChat(chat)
        }
      }
    ],
    [
      handleAutoRenameChat,
      handleClearChatMessages,
      handleCopyChatAsJson,
      handleCopyChatAsMarkdown,
      handleCopyChatAsPlainText,
      handleDeleteChat,
      handleRenameChat,
      index?.chats.length,
      t
    ]
  )

  // Keep chat recency up to date and auto-rename unnamed chats after first successful response.
  useEffect(() => {
    if (!canvasId) return

    const unsubscribe = EventEmitter.on(
      EVENT_NAMES.MESSAGE_COMPLETE,
      ({ topicId, status }: { topicId?: string; status?: string }) => {
        if (status !== 'success' || !topicId) return

        const parsed = parseCanvasChatTopicId(topicId)
        if (parsed && parsed.canvasId !== canvasId) return

        void CanvasChatService.touchChatByTopicId({ canvasId, topicId })
          .then(() => refreshIndex())
          .catch((error) => {
            logger.debug('Failed to touch canvas chat on message complete (ignored):', error as Error)
          })

        const chat = index?.chats.find((entry) => entry.topicId === topicId)
        if (!chat) return
        if (chat.isNameManuallyEdited) return
        if (chat.name?.trim()) return

        if (autoRenameLocksRef.current.has(chat.id)) return
        autoRenameLocksRef.current.add(chat.id)

        void handleAutoRenameChat(chat).finally(() => {
          autoRenameLocksRef.current.delete(chat.id)
        })
      }
    )

    return () => {
      unsubscribe()
    }
  }, [canvasId, handleAutoRenameChat, index?.chats, refreshIndex])

  useEffect(() => {
    if (!canvasId) return

    const unsubComments = EventEmitter.on(
      EVENT_NAMES.CANVAS_COMMENTS_UPDATED,
      ({ canvasId: updatedCanvasId }: { canvasId?: string }) => {
        if (!updatedCanvasId || updatedCanvasId !== canvasId) return
        void refreshComments()
      }
    )

    const unsubInlineSend = EventEmitter.on(
      EVENT_NAMES.CANVAS_CHAT_SEND_PROMPT,
      async ({ canvasId: targetCanvasId, content }: { canvasId?: string; content?: string }) => {
        if (!targetCanvasId || targetCanvasId !== canvasId || !content?.trim()) return
        try {
          await sendMessageToActiveCanvasChat(content)
        } catch (error) {
          logger.error('Failed to send inline canvas prompt:', error as Error)
          window.toast?.error?.(t('notes.chat.send_failed'))
        }
      }
    )

    return () => {
      unsubComments()
      unsubInlineSend()
    }
  }, [canvasId, refreshComments, sendMessageToActiveCanvasChat, t])

  const handleNewChat = useCallback(
    async (assistantId: string) => {
      if (!canvasId) return
      if (!assistantId) return

      setCreatingChat(true)
      try {
        const created = await CanvasChatService.createChat({ canvasId, assistantId })
        await refreshIndex()
        setActiveChatId(created.id)
      } catch (error) {
        logger.error('Failed to create canvas chat:', error as Error)
        window.toast?.error?.(t('notes.chat.create_failed'))
      } finally {
        setCreatingChat(false)
      }
    },
    [canvasId, refreshIndex, t]
  )

  const handleAddHumanComment = useCallback(async () => {
    if (!canvasId) return
    const selection = getCurrentSelection?.()
    if (!selection?.text?.trim()) {
      window.toast?.warning?.(t('notes.comments.select_text_first'))
      return
    }

    const commentText = await PromptPopup.show({
      title: t('notes.comments.add'),
      message: t('notes.comments.add_prompt')
    })
    if (commentText === null) return
    const trimmed = commentText.trim()
    if (!trimmed) return

    try {
      if (
        typeof selection.startOffset === 'number' &&
        typeof selection.endOffset === 'number' &&
        typeof getCurrentMarkdown === 'function'
      ) {
        const markdown = getCurrentMarkdown()
        await CanvasCommentService.addCommentByOffsets({
          canvasId,
          markdownContent: markdown,
          startOffset: selection.startOffset,
          endOffset: selection.endOffset,
          comment: trimmed,
          type: 'none',
          createdBy: 'human'
        })
      } else {
        await CanvasCommentService.addCommentByPattern({
          notesPath,
          canvasId,
          pattern: selection.text,
          comment: trimmed,
          type: 'none',
          createdBy: 'human'
        })
      }

      await refreshComments()
      window.toast?.success?.(t('notes.comments.add_success'))
    } catch (error) {
      logger.error('Failed to add human canvas comment:', error as Error)
      window.toast?.error?.(t('notes.comments.add_failed'))
    }
  }, [canvasId, getCurrentMarkdown, getCurrentSelection, notesPath, refreshComments, t])

  const handleReplyComment = useCallback(
    async (comment: CanvasCommentEntry) => {
      if (!canvasId) return

      const replyText = await PromptPopup.show({
        title: t('notes.comments.reply'),
        message: '',
        defaultValue: ''
      })
      if (replyText === null) return
      const trimmed = replyText.trim()
      if (!trimmed) return

      try {
        await CanvasCommentService.replyToComment({
          canvasId,
          commentId: comment.id,
          content: trimmed,
          author: 'human'
        })
        await refreshComments()

        const structured = [
          `Canvas comment reply (${comment.id})`,
          `Comment: ${comment.content}`,
          `Anchor: ${comment.anchorPreview}`,
          `Reply: ${trimmed}`
        ].join('\n')
        await sendMessageToActiveCanvasChat(structured)
      } catch (error) {
        logger.error('Failed to reply canvas comment:', error as Error)
        window.toast?.error?.(t('notes.comments.reply_failed'))
      }
    },
    [canvasId, refreshComments, sendMessageToActiveCanvasChat, t]
  )

  const handleToggleResolved = useCallback(
    async (comment: CanvasCommentEntry) => {
      if (!canvasId) return
      try {
        await CanvasCommentService.setCommentResolved({
          canvasId,
          commentId: comment.id,
          resolved: comment.status !== 'resolved',
          actor: 'human'
        })
        await refreshComments()
      } catch (error) {
        logger.error('Failed to toggle canvas comment resolved state:', error as Error)
        window.toast?.error?.(t('notes.comments.resolve_failed'))
      }
    },
    [canvasId, refreshComments, t]
  )

  if (!open) return null

  if (!notesPath || !filePath) {
    return (
      <Container style={{ width: panelWidth, flex: '0 0 auto' }}>
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
    <Container style={{ width: panelWidth, flex: '0 0 auto' }}>
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

      <Body>
        <ViewSwitchRow>
          <ViewSwitchButton
            size="small"
            type={activeView === 'chat' ? 'primary' : 'default'}
            icon={<MessagesSquare size={14} />}
            onClick={() => setActiveView('chat')}>
            {t('notes.chat.title')}
          </ViewSwitchButton>
          <ViewSwitchButton
            size="small"
            type={activeView === 'comments' ? 'primary' : 'default'}
            icon={<MessageCircle size={14} />}
            onClick={() => setActiveView('comments')}>
            {t('notes.comments.title')}
          </ViewSwitchButton>
        </ViewSwitchRow>

        <ToolbarRow>
          {activeView === 'chat' ? (
            <>
              <Select
                style={{ flex: 1, minWidth: 0 }}
                size="small"
                value={activeChat?.assistantId}
                placeholder={t('notes.chat.select_assistant')}
                options={assistantOptions}
                disabled={creatingChat || loading || !canvasId}
                onChange={(assistantId) => {
                  // Requirement: switching assistant starts a NEW chat thread.
                  void handleNewChat(assistantId)
                }}
              />
              <Tooltip title={t('notes.chat.new_chat')}>
                <Button
                  size="small"
                  icon={<Plus size={16} />}
                  loading={creatingChat}
                  disabled={creatingChat || loading || !canvasId}
                  onClick={() => {
                    const assistantId = activeChat?.assistantId || defaultAssistantId || assistants[0]?.id
                    if (!assistantId) return
                    void handleNewChat(assistantId)
                  }}
                />
              </Tooltip>
              <Tooltip title={isChatListVisible ? t('notes.chat.hide_list') : t('notes.chat.show_list')}>
                <Button
                  size="small"
                  type="text"
                  icon={isChatListVisible ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
                  onClick={() => setIsChatListVisible((prev) => !prev)}
                />
              </Tooltip>
            </>
          ) : (
            <Tooltip title={t('notes.comments.add')}>
              <Button
                size="small"
                type="primary"
                icon={<Plus size={16} />}
                disabled={!canvasId || commentsLoading}
                onClick={() => {
                  void handleAddHumanComment()
                }}>
                {t('notes.comments.add')}
              </Button>
            </Tooltip>
          )}
        </ToolbarRow>

        {activeView === 'chat' ? (
          <ChatLayout $direction={shouldStackChatList ? 'column' : 'row'}>
            {isChatListVisible && (
              <ChatList $variant={shouldStackChatList ? 'top' : 'side'}>
                {!index?.chats?.length ? (
                  <Empty description={t('notes.chat.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
                ) : (
                  index.chats.map((chat) => {
                    const isActive = chat.id === activeChat?.id
                    const title = getChatTitle(chat)
                    const assistantName = CanvasChatService.getAssistantName(chat.assistantId)
                    const time = dayjs(chat.updatedAt ?? chat.createdAt).format('MM/DD HH:mm')
                    const originLabel =
                      chat.origin === 'main-chat'
                        ? t('notes.chat.origin_main')
                        : chat.origin === 'thread'
                          ? t('notes.chat.origin_thread')
                          : ''
                    const metaBase = title === assistantName ? time : `${assistantName} · ${time}`
                    const meta = originLabel ? `${metaBase} · ${originLabel}` : metaBase

                    return (
                      <Dropdown
                        key={chat.id}
                        menu={{ items: buildChatMenuItems(chat) }}
                        trigger={['contextMenu']}
                        popupRender={(menu) => <div onPointerDown={(e) => e.stopPropagation()}>{menu}</div>}>
                        <ChatListItem
                          role="button"
                          tabIndex={0}
                          $active={isActive}
                          onClick={() => setActiveChatId(chat.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              setActiveChatId(chat.id)
                            }
                          }}>
                          <ChatListItemTitle ellipsis={{ tooltip: title }}>{title}</ChatListItemTitle>
                          <ChatListItemMeta>{meta}</ChatListItemMeta>
                        </ChatListItem>
                      </Dropdown>
                    )
                  })
                )}
              </ChatList>
            )}

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
        ) : (
          <CommentsContainer>
            {commentsLoading ? (
              <Empty description={t('common.loading')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : !commentsIndex?.comments?.length ? (
              <Empty description={t('notes.comments.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              commentsIndex.comments.map((comment) => (
                <CommentCard key={comment.id}>
                  <CommentHeader>
                    <Tag
                      color={
                        comment.type === 'important'
                          ? 'red'
                          : comment.type === 'suggestion'
                            ? 'gold'
                            : comment.type === 'question'
                              ? 'blue'
                              : 'default'
                      }>
                      {comment.type}
                    </Tag>
                    <CommentMeta>
                      {dayjs(comment.updatedAt || comment.createdAt).format('MM/DD HH:mm')}
                      {comment.status === 'resolved' ? ` · ${t('notes.comments.resolved')}` : ''}
                    </CommentMeta>
                  </CommentHeader>
                  <CommentAnchor title={comment.anchorPreview}>{comment.anchorPreview}</CommentAnchor>
                  <CommentText>{comment.content}</CommentText>

                  {comment.replies.length > 0 && (
                    <RepliesContainer>
                      {comment.replies.map((reply) => (
                        <ReplyRow key={reply.id}>
                          <ReplyMeta>
                            {reply.author} · {dayjs(reply.createdAt).format('MM/DD HH:mm')}
                          </ReplyMeta>
                          <ReplyText>{reply.content}</ReplyText>
                        </ReplyRow>
                      ))}
                    </RepliesContainer>
                  )}

                  <CommentActions>
                    <Button
                      size="small"
                      type="text"
                      onClick={() => {
                        void handleReplyComment(comment)
                      }}>
                      {t('notes.comments.reply')}
                    </Button>
                    <Button
                      size="small"
                      type="text"
                      onClick={() => {
                        void handleToggleResolved(comment)
                      }}>
                      {comment.status === 'resolved' ? t('notes.comments.reopen') : t('notes.comments.resolve')}
                    </Button>
                  </CommentActions>
                </CommentCard>
              ))
            )}
          </CommentsContainer>
        )}
      </Body>
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
  box-sizing: border-box;
  min-height: 0;
  overflow: hidden;
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

const Body = styled.div`
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  min-width: 0;
  gap: 8px;
`

const ToolbarRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
`

const ViewSwitchRow = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`

const ViewSwitchButton = styled(Button)`
  display: inline-flex;
  align-items: center;
  gap: 6px;
`

const ChatLayout = styled.div<{ $direction: 'row' | 'column' }>`
  display: flex;
  gap: 8px;
  min-height: 0;
  flex: 1;
  min-width: 0;
  flex-direction: ${({ $direction }) => $direction};
`

const ChatList = styled.div<{ $variant: 'side' | 'top' }>`
  flex: ${({ $variant }) => ($variant === 'side' ? '0 0 220px' : '0 0 auto')};
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: ${({ $variant }) => ($variant === 'side' ? '4px' : '0')};
  padding-bottom: ${({ $variant }) => ($variant === 'top' ? '4px' : '0')};
  max-height: ${({ $variant }) => ($variant === 'top' ? '200px' : 'none')};
`

const ChatListItem = styled.div<{ $active: boolean }>`
  padding: 6px 10px;
  border-radius: var(--list-item-border-radius);
  display: flex;
  flex-direction: column;
  gap: 2px;
  cursor: pointer;
  background-color: ${({ $active }) => ($active ? 'var(--color-list-item)' : 'transparent')};
  box-shadow: ${({ $active }) => ($active ? '0 1px 2px 0 rgba(0, 0, 0, 0.05)' : 'none')};

  &:hover {
    background-color: ${({ $active }) => ($active ? 'var(--color-list-item)' : 'var(--color-list-item-hover)')};
    transition: background-color 0.1s;
  }
`

const ChatListItemTitle = styled(Typography.Text)`
  font-size: 13px;
  line-height: 1.25;
`

const ChatListItemMeta = styled(Typography.Text)`
  font-size: 12px;
  color: var(--color-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

const CommentsContainer = styled.div`
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
`

const CommentCard = styled.div`
  border: 1px solid var(--color-border-soft);
  background: var(--color-background-soft);
  border-radius: 10px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
`

const CommentHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
`

const CommentMeta = styled(Typography.Text)`
  font-size: 12px;
  color: var(--color-text-3);
`

const CommentAnchor = styled.div`
  font-size: 12px;
  color: var(--color-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const CommentText = styled.div`
  color: var(--color-text);
  white-space: pre-wrap;
  word-break: break-word;
`

const RepliesContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border-radius: 8px;
  background: var(--color-background);
`

const ReplyRow = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
`

const ReplyMeta = styled(Typography.Text)`
  font-size: 11px;
  color: var(--color-text-3);
`

const ReplyText = styled.div`
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
`

const CommentActions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 6px;
`

export default CanvasChatSidebar
