import { loggerService } from '@logger'
import ContextMenu from '@renderer/components/ContextMenu'
import { LoadingIcon } from '@renderer/components/Icons'
import { LOAD_MORE_COUNT } from '@renderer/config/constant'
import { useAssistant } from '@renderer/hooks/useAssistant'
import type { ChatContextOptions } from '@renderer/hooks/useChatContext'
import { useChatContext } from '@renderer/hooks/useChatContext'
import { useMessageOperations, useTopicMessages } from '@renderer/hooks/useMessageOperations'
import useScrollPosition from '@renderer/hooks/useScrollPosition'
import { useSettings } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useTimer } from '@renderer/hooks/useTimer'
import { autoRenameTopic } from '@renderer/hooks/useTopic'
import SelectionBox from '@renderer/pages/home/Messages/SelectionBox'
import { getDefaultTopic } from '@renderer/services/AssistantService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { getContextCount, getGroupedMessages, getUserMessage } from '@renderer/services/MessagesService'
import { estimateHistoryTokens } from '@renderer/services/TokenService'
import store, { useAppDispatch } from '@renderer/store'
import { messageBlocksSelectors, updateOneBlock } from '@renderer/store/messageBlock'
import { newMessagesActions } from '@renderer/store/newMessage'
import { saveMessageAndBlocksToDB, updateMessageAndBlocksThunk } from '@renderer/store/thunk/messageThunk'
import type { Assistant, Topic } from '@renderer/types'
import type { MessageBlock } from '@renderer/types/newMessage'
import { type Message, MessageBlockType } from '@renderer/types/newMessage'
import {
  captureScrollableAsBlob,
  captureScrollableAsDataURL,
  removeSpecialCharactersForFileName,
  runAsyncFunction
} from '@renderer/utils'
import { scrollIntoView } from '@renderer/utils/dom'
import { updateCodeBlock } from '@renderer/utils/markdown'
import { getMainTextContent } from '@renderer/utils/messageUtils/find'
import { isTextLikeBlock } from '@renderer/utils/messageUtils/is'
import { last } from 'lodash'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import InfiniteScroll from 'react-infinite-scroll-component'
import styled from 'styled-components'

import MessageAnchorLine from './MessageAnchorLine'
import MessageGroup from './MessageGroup'
import NarrowLayout from './NarrowLayout'
import Prompt from './Prompt'
import { MessagesContainer, ScrollContainer } from './shared'

interface MessagesProps {
  assistant: Assistant
  topic: Topic
  setActiveTopic: (topic: Topic) => void
  onComponentUpdate?(): void
  onFirstUpdate?(): void
  // DOM id for the scroll container. Must be unique when multiple message views exist.
  containerId?: string
  // When rendering messages in nested contexts (thread sidebars), prevent global chat state changes.
  chatContextOptions?: ChatContextOptions
  // Thread topics clone context messages; callers can hide the prefix.
  skipLeadingMessages?: number
  // Disable global event handlers (NEW_CONTEXT, CLEAR_MESSAGES, etc.) for nested message views.
  enableGlobalEvents?: boolean
  // Disable global shortcuts in nested views to avoid conflicts with main chat.
  enableShortcuts?: boolean
  // Optional hint shown when there are no visible messages.
  emptyHint?: string
  // Hide the "Prompt" section in nested views like thread sidebars.
  hidePrompt?: boolean
  // When enabled (e.g. in-chat find), progressively render older messages so DOM-based search sees more matches.
  // Bounded by time + batch caps to avoid freezing on huge topics.
  autoExpandForSearch?: boolean
}

interface LocateMessagePayload {
  messageId: string
  topicId?: string
  highlight?: boolean
}

const logger = loggerService.withContext('Messages')

const Messages: React.FC<MessagesProps> = ({
  assistant,
  topic,
  setActiveTopic,
  onComponentUpdate,
  onFirstUpdate,
  containerId = 'messages',
  chatContextOptions,
  skipLeadingMessages = 0,
  enableGlobalEvents = true,
  enableShortcuts = true,
  emptyHint,
  hidePrompt = false,
  autoExpandForSearch = false
}) => {
  const { containerRef: scrollContainerRef, handleScroll: handleScrollPosition } = useScrollPosition(
    `topic-${topic.id}`
  )
  const [displayMessages, setDisplayMessages] = useState<Message[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [isProcessingContext, setIsProcessingContext] = useState(false)

  const { addTopic } = useAssistant(assistant.id)
  const { showPrompt, messageNavigation } = useSettings()
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const rawMessages = useTopicMessages(topic.id)
  const messages = useMemo(
    () => (skipLeadingMessages > 0 ? rawMessages.slice(skipLeadingMessages) : rawMessages),
    [rawMessages, skipLeadingMessages]
  )
  const { displayCount, clearTopicMessages, deleteMessage, createTopicBranch } = useMessageOperations(topic)
  const { setTimeoutTimer } = useTimer()

  const { isMultiSelectMode, handleSelectMessage } = useChatContext(topic, chatContextOptions)

  const messageElements = useRef<Map<string, HTMLElement>>(new Map())
  const messagesRef = useRef<Message[]>(messages)
  const displayMessagesRef = useRef<Message[]>([])
  const messagesLengthRef = useRef(0)

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    displayMessagesRef.current = displayMessages
  }, [displayMessages])

  const registerMessageElement = useCallback((id: string, element: HTMLElement | null) => {
    if (element) {
      messageElements.current.set(id, element)
    } else {
      messageElements.current.delete(id)
    }
  }, [])

  useEffect(() => {
    const prevTotalLength = messagesLengthRef.current
    const nextTotalLength = messages.length
    const delta = nextTotalLength - prevTotalLength
    messagesLengthRef.current = nextTotalLength

    const baseDisplayMessages = computeDisplayMessages(messages, 0, displayCount)
    const reversedMessages = [...messages].reverse()

    const prevDisplayedLength = displayMessagesRef.current.length
    const baseDisplayedLength = baseDisplayMessages.length

    // `displayMessages` is always a prefix of `reversedMessages` (see computeDisplayMessages implementation).
    // When the user has loaded more (or when search auto-expands), keep the already-rendered prefix length,
    // and include any newly appended messages (delta > 0) so the newest content still appears.
    const shouldPreserveExpanded = prevDisplayedLength > baseDisplayedLength || autoExpandForSearch

    const desiredLength = (() => {
      if (prevDisplayedLength === 0) return baseDisplayedLength
      if (!shouldPreserveExpanded) return baseDisplayedLength
      return Math.min(prevDisplayedLength + Math.max(0, delta), reversedMessages.length)
    })()

    const nextDisplayMessages = reversedMessages.slice(0, desiredLength)

    setDisplayMessages(nextDisplayMessages)
    displayMessagesRef.current = nextDisplayMessages
    setHasMore(desiredLength < reversedMessages.length)
  }, [autoExpandForSearch, displayCount, messages])

  const appendMoreMessages = useCallback((batchGroupsCount: number) => {
    const currentLength = displayMessagesRef.current.length
    const currentMessages = messagesRef.current

    if (currentMessages.length === 0) return

    // No more items left to append.
    if (currentLength >= currentMessages.length) {
      setHasMore(false)
      return
    }

    const newMessages = computeDisplayMessages(currentMessages, currentLength, batchGroupsCount)
    if (newMessages.length === 0) {
      setHasMore(false)
      return
    }

    setDisplayMessages((prev) => {
      const next = [...prev, ...newMessages]
      displayMessagesRef.current = next
      return next
    })

    const nextLength = currentLength + newMessages.length
    setHasMore(nextLength < currentMessages.length)
  }, [])

  // NOTE: 如果设置为平滑滚动会导致滚动条无法跟随生成的新消息保持在底部位置
  const scrollToBottom = useCallback(() => {
    if (scrollContainerRef.current) {
      requestAnimationFrame(() => {
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTo({ top: 0 })
        }
      })
    }
  }, [scrollContainerRef])

  const clearTopic = useCallback(
    async (data: Topic) => {
      if (data && data.id !== topic.id) {
        await clearTopicMessages(data.id)
        return
      }

      await clearTopicMessages()
      setDisplayMessages([])
    },
    [clearTopicMessages, topic.id]
  )

  const locateMessage = useCallback(
    (messageId: string, highlight: boolean = true) => {
      const targetMessage = messagesRef.current.find((message) => message.id === messageId)
      if (!targetMessage) return

      if (targetMessage.role === 'assistant' && targetMessage.askId) {
        const groupedMessages = messagesRef.current.filter((message) => message.askId === targetMessage.askId)

        if (groupedMessages.length > 1) {
          groupedMessages.forEach((message) => {
            const isSelected = message.id === targetMessage.id
            if (message.foldSelected === isSelected) return

            dispatch(
              newMessagesActions.updateMessage({
                topicId: message.topicId,
                messageId: message.id,
                updates: { foldSelected: isSelected }
              })
            )
          })
        }
      }

      setTimeoutTimer(
        `locateMessage:${messageId}`,
        () => {
          const messageElement = document.getElementById(`message-${messageId}`)
          if (!messageElement) return

          scrollIntoView(messageElement, { behavior: 'smooth', block: 'center', container: 'nearest' })

          if (!highlight) return

          messageElement.classList.add('animation-locate-highlight')

          const handleAnimationEnd = () => {
            messageElement.classList.remove('animation-locate-highlight')
            messageElement.removeEventListener('animationend', handleAnimationEnd)
          }

          messageElement.addEventListener('animationend', handleAnimationEnd)
        },
        120
      )
    },
    [dispatch, setTimeoutTimer]
  )

  const revealAndLocateMessage = useCallback(
    (messageId: string, highlight: boolean = true) => {
      const currentMessages = messagesRef.current
      if (!currentMessages.length) return

      const reversedMessages = [...currentMessages].reverse()
      const targetIndex = reversedMessages.findIndex((m) => m.id === messageId)
      if (targetIndex === -1) return

      const desiredLength = targetIndex + 1
      const currentLength = displayMessagesRef.current.length

      if (currentLength < desiredLength) {
        const nextDisplayMessages = reversedMessages.slice(0, desiredLength)
        setDisplayMessages(nextDisplayMessages)
        displayMessagesRef.current = nextDisplayMessages
        setHasMore(desiredLength < reversedMessages.length)
      }

      // Wait a tick for render to ensure the target DOM node exists, then locate it.
      setTimeoutTimer(`revealAndLocateMessage:${messageId}`, () => locateMessage(messageId, highlight), 100)
    },
    [locateMessage, setTimeoutTimer]
  )

  useEffect(() => {
    const unsubscribe = EventEmitter.on(EVENT_NAMES.LOCATE_MESSAGE, (payload: LocateMessagePayload) => {
      if (!payload?.messageId) return
      if (payload.topicId && payload.topicId !== topic.id) return

      revealAndLocateMessage(payload.messageId, payload.highlight ?? true)
    })

    return () => unsubscribe()
  }, [revealAndLocateMessage, topic.id])

  useEffect(() => {
    if (!enableGlobalEvents) return
    const unsubscribes = [
      EventEmitter.on(EVENT_NAMES.SEND_MESSAGE, scrollToBottom),
      EventEmitter.on(
        EVENT_NAMES.REVEAL_MESSAGE,
        (payload: { topicId: string; messageId: string; highlight?: boolean }) => {
          if (containerId !== 'messages') return
          if (!payload?.topicId || payload.topicId !== topic.id) return
          if (!payload?.messageId) return

          revealAndLocateMessage(payload.messageId, payload.highlight ?? true)
        }
      ),
      EventEmitter.on(EVENT_NAMES.CLEAR_MESSAGES, async (data: Topic) => {
        window.modal.confirm({
          title: t('chat.input.clear.title'),
          content: t('chat.input.clear.content'),
          centered: true,
          onOk: () => clearTopic(data)
        })
      }),
      EventEmitter.on(EVENT_NAMES.COPY_TOPIC_IMAGE, async () => {
        await captureScrollableAsBlob(scrollContainerRef, async (blob) => {
          if (blob) {
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
          }
        })
      }),
      EventEmitter.on(EVENT_NAMES.EXPORT_TOPIC_IMAGE, async () => {
        const imageData = await captureScrollableAsDataURL(scrollContainerRef)
        if (imageData) {
          window.api.file.saveImage(removeSpecialCharactersForFileName(topic.name), imageData)
        }
      }),
      EventEmitter.on(EVENT_NAMES.NEW_CONTEXT, async () => {
        if (isProcessingContext) return
        setIsProcessingContext(true)

        try {
          const messages = messagesRef.current

          if (messages.length === 0) {
            return
          }

          const lastMessage = last(messages)

          if (lastMessage?.type === 'clear') {
            await deleteMessage(lastMessage.id)
            scrollToBottom()
            return
          }

          const { message: clearMessage } = getUserMessage({ assistant, topic, type: 'clear' })
          dispatch(newMessagesActions.addMessage({ topicId: topic.id, message: clearMessage }))
          await saveMessageAndBlocksToDB(topic.id, clearMessage, [])

          scrollToBottom()
        } finally {
          setIsProcessingContext(false)
        }
      }),
      EventEmitter.on(EVENT_NAMES.NEW_BRANCH, async (index: number) => {
        const newTopic = getDefaultTopic(assistant.id)
        newTopic.name = topic.name
        const currentMessages = messagesRef.current

        if (index < 0 || index > currentMessages.length) {
          logger.error(`[NEW_BRANCH] Invalid branch index: ${index}`)
          return
        }

        // 1. Add the new topic to Redux store FIRST
        addTopic(newTopic)

        // 2. Call the thunk to clone messages and update DB
        const success = await createTopicBranch(topic.id, currentMessages.length - index, newTopic)

        if (success) {
          // 3. Set the new topic as active
          setActiveTopic(newTopic)
          // 4. Trigger auto-rename for the new topic
          autoRenameTopic(assistant, newTopic.id)
        } else {
          // Optional: Handle cloning failure (e.g., show an error message)
          // You might want to remove the added topic if cloning fails
          // removeTopic(newTopic.id); // Assuming you have a removeTopic function
          logger.error(`[NEW_BRANCH] Failed to create topic branch for topic ${newTopic.id}`)
          window.toast.error(t('message.branch.error')) // Example error message
        }
      }),
      EventEmitter.on(
        EVENT_NAMES.EDIT_CODE_BLOCK,
        async (data: { msgBlockId: string; codeBlockId: string; newContent: string }) => {
          const { msgBlockId, codeBlockId, newContent } = data

          const msgBlock = messageBlocksSelectors.selectById(store.getState(), msgBlockId)

          // FIXME: 目前 error block 没有 content
          if (msgBlock && isTextLikeBlock(msgBlock) && msgBlock.type !== MessageBlockType.ERROR) {
            try {
              const updatedRaw = updateCodeBlock(msgBlock.content, codeBlockId, newContent)
              const updatedBlock: MessageBlock = {
                ...msgBlock,
                content: updatedRaw,
                updatedAt: new Date().toISOString()
              }

              dispatch(updateOneBlock({ id: msgBlockId, changes: { content: updatedRaw } }))
              await dispatch(updateMessageAndBlocksThunk(topic.id, null, [updatedBlock]))

              window.toast.success(t('code_block.edit.save.success'))
            } catch (error) {
              logger.error(
                `Failed to save code block ${codeBlockId} content to message block ${msgBlockId}:`,
                error as Error
              )
              window.toast.error(t('code_block.edit.save.failed.label'))
            }
          } else {
            logger.error(
              `Failed to save code block ${codeBlockId} content to message block ${msgBlockId}: no such message block or the block doesn't have a content field`
            )
            window.toast.error(t('code_block.edit.save.failed.label'))
          }
        }
      )
    ]

    return () => unsubscribes.forEach((unsub) => unsub())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    assistant,
    containerId,
    dispatch,
    enableGlobalEvents,
    isProcessingContext,
    revealAndLocateMessage,
    scrollToBottom,
    t,
    topic
  ])

  useEffect(() => {
    runAsyncFunction(async () => {
      EventEmitter.emit(EVENT_NAMES.ESTIMATED_TOKEN_COUNT, {
        tokensCount: await estimateHistoryTokens(assistant, messages),
        contextCount: getContextCount(assistant, messages)
      })
    }).then(() => onFirstUpdate?.())
  }, [assistant, messages, onFirstUpdate])

  const loadMoreMessages = useCallback(() => {
    if (!hasMore || isLoadingMore) return

    setIsLoadingMore(true)
    setTimeoutTimer(
      'loadMoreMessages',
      () => {
        appendMoreMessages(LOAD_MORE_COUNT)
        setIsLoadingMore(false)
      },
      300
    )
  }, [appendMoreMessages, hasMore, isLoadingMore, setTimeoutTimer])

  // When in-chat search is open, progressively expand rendered history so DOM-based search sees more matches.
  // Bound by a time budget and batch cap to avoid freezing on extremely large topics.
  useEffect(() => {
    if (!autoExpandForSearch) return

    const AUTO_EXPAND_MAX_MS = 5000
    const AUTO_EXPAND_MAX_BATCHES = 25 // ~500 groups max (LOAD_MORE_COUNT is 20)

    let cancelled = false
    const startedAt = performance.now()
    let batches = 0

    const step = () => {
      if (cancelled) return
      if (batches >= AUTO_EXPAND_MAX_BATCHES) return
      if (performance.now() - startedAt >= AUTO_EXPAND_MAX_MS) return

      const currentLength = displayMessagesRef.current.length
      const total = messagesRef.current.length

      if (total === 0 || currentLength >= total) {
        setHasMore(false)
        return
      }

      appendMoreMessages(LOAD_MORE_COUNT)
      batches += 1

      // Yield to allow React/DOM to render the newly added messages before the next search refresh.
      setTimeout(step, 0)
    }

    step()

    return () => {
      cancelled = true
    }
  }, [appendMoreMessages, autoExpandForSearch])

  useShortcut(
    'copy_last_message',
    () => {
      const lastMessage = last(messages)
      if (lastMessage) {
        navigator.clipboard.writeText(getMainTextContent(lastMessage))
        window.toast.success(t('message.copy.success'))
      }
    },
    { enabled: enableShortcuts }
  )

  useShortcut(
    'edit_last_user_message',
    () => {
      const lastUserMessage = messagesRef.current.findLast((m) => m.role === 'user' && m.type !== 'clear')
      if (lastUserMessage) {
        EventEmitter.emit(EVENT_NAMES.EDIT_MESSAGE, lastUserMessage.id)
      }
    },
    { enabled: enableShortcuts }
  )

  useEffect(() => {
    requestAnimationFrame(() => onComponentUpdate?.())
  }, [onComponentUpdate])

  // NOTE: 因为displayMessages是倒序的，所以得到的groupedMessages每个group内部也是倒序的，需要再倒一遍
  const groupedMessages = useMemo(() => {
    const grouped = Object.entries(getGroupedMessages(displayMessages))
    const newGrouped: {
      [key: string]: (Message & {
        index: number
      })[]
    } = {}
    grouped.forEach(([key, group]) => {
      newGrouped[key] = group.toReversed()
    })
    return Object.entries(newGrouped)
  }, [displayMessages])

  return (
    <MessagesContainer
      id={containerId}
      className="messages-container"
      ref={scrollContainerRef}
      key={assistant.id}
      onScroll={handleScrollPosition}>
      <NarrowLayout style={{ display: 'flex', flexDirection: 'column-reverse' }}>
        <InfiniteScroll
          dataLength={displayMessages.length}
          next={loadMoreMessages}
          hasMore={hasMore}
          loader={null}
          scrollableTarget={containerId}
          inverse
          style={{ overflow: 'visible' }}>
          <ContextMenu>
            <ScrollContainer>
              {groupedMessages.map(([key, groupMessages]) => (
                <MessageGroup
                  key={key}
                  messages={groupMessages}
                  topic={topic}
                  registerMessageElement={registerMessageElement}
                  chatContextOptions={chatContextOptions}
                />
              ))}
              {displayMessages.length === 0 && emptyHint && <EmptyHint>{emptyHint}</EmptyHint>}
              {isLoadingMore && (
                <LoaderContainer>
                  <LoadingIcon color="var(--color-text-2)" />
                </LoaderContainer>
              )}
            </ScrollContainer>
          </ContextMenu>
        </InfiniteScroll>

        {showPrompt && !hidePrompt && <Prompt assistant={assistant} key={assistant.prompt} topic={topic} />}
      </NarrowLayout>
      {messageNavigation === 'anchor' && <MessageAnchorLine messages={displayMessages} />}
      <SelectionBox
        isMultiSelectMode={isMultiSelectMode}
        scrollContainerRef={scrollContainerRef}
        messageElements={messageElements.current}
        handleSelectMessage={handleSelectMessage}
      />
    </MessagesContainer>
  )
}

const computeDisplayMessages = (messages: Message[], startIndex: number, displayCount: number) => {
  const reversedMessages = [...messages].reverse()

  // 如果剩余消息数量小于 displayCount，直接返回所有剩余消息
  if (reversedMessages.length - startIndex <= displayCount) {
    return reversedMessages.slice(startIndex)
  }

  const userIdSet = new Set() // 用户消息 id 集合
  const assistantIdSet = new Set() // 助手消息 askId 集合
  const displayMessages: Message[] = []

  // 处理单条消息的函数
  const processMessage = (message: Message) => {
    if (!message) return

    const idSet = message.role === 'user' ? userIdSet : assistantIdSet
    const messageId = message.role === 'user' ? message.id : message.askId

    if (!idSet.has(messageId)) {
      idSet.add(messageId)
      displayMessages.push(message)
      return
    }
    // 如果是相同 askId 的助手消息，也要显示
    displayMessages.push(message)
  }

  // 遍历消息直到满足显示数量要求
  for (let i = startIndex; i < reversedMessages.length && userIdSet.size + assistantIdSet.size < displayCount; i++) {
    processMessage(reversedMessages[i])
  }

  return displayMessages
}

const LoaderContainer = styled.div`
  display: flex;
  justify-content: center;
  padding: 10px;
  width: 100%;
  background: var(--color-background);
  pointer-events: none;
`

const EmptyHint = styled.div`
  padding: 12px;
  color: var(--color-text-3);
  font-size: 13px;
`

export default Messages
