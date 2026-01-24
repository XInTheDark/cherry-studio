import { DynamicVirtualList, type DynamicVirtualListRef } from '@renderer/components/VirtualList'
import { useTopicMessages } from '@renderer/hooks/useMessageOperations'
import { useRuntime } from '@renderer/hooks/useRuntime'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import type { RootState } from '@renderer/store'
import { messageBlocksSelectors } from '@renderer/store/messageBlock'
import type { Topic } from '@renderer/types'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'
import { Popover, Tooltip } from 'antd'
import { throttle } from 'lodash'
import { ListOrdered, X } from 'lucide-react'
import type { FC } from 'react'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSelector } from 'react-redux'
import styled from 'styled-components'

import { NavbarIcon } from '../ChatNavbar'

interface Props {
  topic: Topic
}

const PREVIEW_ROW_MAX_CHARS = 140
const PREVIEW_HOVER_MAX_CHARS = 600

const normalizePreviewText = (text: string) => {
  return text.replace(/\s+/g, ' ').trim()
}

const truncateText = (text: string, maxChars: number) => {
  const normalized = normalizePreviewText(text)
  if (normalized.length <= maxChars) return normalized
  return normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd() + '...'
}

const getBlocksForMessage = (message: Message, blockEntities: Record<string, MessageBlock | undefined>) => {
  if (!message.blocks?.length) return []
  return message.blocks.map((id) => blockEntities[id]).filter((b): b is MessageBlock => !!b)
}

const getPreviewForMessage = (
  message: Message,
  blockEntities: Record<string, MessageBlock | undefined>,
  empty: string
) => {
  if (message.type === 'clear') return empty

  const blocks = getBlocksForMessage(message, blockEntities)
  const mainText = blocks
    .filter((b) => b.type === MessageBlockType.MAIN_TEXT)
    .map((b) => (b.type === MessageBlockType.MAIN_TEXT ? b.content : ''))
    .join('\n\n')
    .trim()

  if (mainText) return mainText
  if (blocks.some((b) => b.type === MessageBlockType.IMAGE)) return '[Image]'
  if (blocks.some((b) => b.type === MessageBlockType.FILE)) return '[File]'
  if (blocks.some((b) => b.type === MessageBlockType.TOOL)) return '[Tool]'
  if (blocks.some((b) => b.type === MessageBlockType.CITATION)) return '[Citations]'
  if (blocks.some((b) => b.type === MessageBlockType.ERROR)) return '[Error]'
  if (blocks.some((b) => b.type === MessageBlockType.VIDEO)) return '[Video]'
  if (blocks.some((b) => b.type === MessageBlockType.COMPACT)) return '[Compact]'

  return ''
}

const MessagesTocButton: FC<Props> = ({ topic }) => {
  const { t } = useTranslation()
  const runtime = useRuntime()
  const isTopicMode = runtime.chat?.activeTopicOrSession === 'topic'

  const messages = useTopicMessages(topic.id)
  const blockEntities = useSelector((state: RootState) => messageBlocksSelectors.selectEntities(state))
  const listRef = useRef<DynamicVirtualListRef>(null)

  const [open, setOpen] = useState(false)
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null)

  const emptyContextLabel = t('chat.message.new.context')
  const emptyMessageLabel = t('chat.navigation.toc_empty')

  const computeActiveMessageId = useCallback(() => {
    const scroller = document.getElementById('messages')
    if (!scroller) {
      setActiveMessageId(null)
      return null
    }

    const scrollerRect = scroller.getBoundingClientRect()
    const centerY = scrollerRect.top + scrollerRect.height / 2

    let bestId: string | null = null
    let bestDist = Number.POSITIVE_INFINITY

    scroller.querySelectorAll<HTMLElement>('.message[data-thread-message-id]').forEach((el) => {
      const id = el.dataset.threadMessageId
      if (!id) return

      const r = el.getBoundingClientRect()
      const elCenterY = r.top + r.height / 2
      const dist = Math.abs(elCenterY - centerY)
      if (dist < bestDist) {
        bestDist = dist
        bestId = id
      }
    })

    setActiveMessageId(bestId)
    return bestId
  }, [])

  useEffect(() => {
    if (!open) return
    const scroller = document.getElementById('messages')
    if (!scroller) return

    const handleScroll = throttle(() => {
      computeActiveMessageId()
    }, 120)

    computeActiveMessageId()

    scroller.addEventListener('scroll', handleScroll, { passive: true })
    window.addEventListener('resize', handleScroll)

    return () => {
      scroller.removeEventListener('scroll', handleScroll)
      window.removeEventListener('resize', handleScroll)
      handleScroll.cancel()
    }
  }, [computeActiveMessageId, open])

  useEffect(() => {
    if (!open) return

    // On open, align the list to the current message (or newest message as fallback).
    requestAnimationFrame(() => {
      const currentId = computeActiveMessageId() ?? messages.at(-1)?.id ?? null
      if (!currentId) return

      const index = messages.findIndex((m) => m.id === currentId)
      if (index < 0) return

      listRef.current?.scrollToIndex(index, { align: 'center' })
    })
  }, [computeActiveMessageId, messages, open])

  const handleSelectMessage = useCallback(
    (messageId: string) => {
      setOpen(false)
      EventEmitter.emit(EVENT_NAMES.REVEAL_MESSAGE, { topicId: topic.id, messageId, highlight: true })
    },
    [topic.id]
  )

  const listItems = useMemo(() => messages, [messages])

  if (!isTopicMode) return null

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="bottomRight"
      arrow={false}
      destroyTooltipOnHide
      overlayStyle={{ zIndex: 1000 }}
      content={
        <Panel>
          <PanelHeader>
            <PanelTitle>{t('chat.navigation.toc')}</PanelTitle>
            <PanelActions>
              <IconButton type="button" onClick={() => setOpen(false)} aria-label={t('chat.navigation.close')}>
                <X size={16} />
              </IconButton>
            </PanelActions>
          </PanelHeader>

          {listItems.length === 0 ? (
            <EmptyState>{t('chat.navigation.toc_empty')}</EmptyState>
          ) : (
            <DynamicVirtualList
              ref={listRef}
              list={listItems}
              estimateSize={() => 44}
              overscan={10}
              size="60vh"
              autoHideScrollbar
              scrollerStyle={{ padding: 6 }}>
              {(message, index) => {
                const previewRaw = getPreviewForMessage(message, blockEntities, emptyContextLabel)
                const preview = truncateText(previewRaw || '', PREVIEW_ROW_MAX_CHARS)
                const hoverPreview = truncateText(previewRaw || '', PREVIEW_HOVER_MAX_CHARS)

                const isActive = message.id === activeMessageId
                const roleLabel = message.role === 'user' ? 'U' : message.role === 'assistant' ? 'A' : 'S'

                return (
                  <Popover
                    key={message.id}
                    trigger="hover"
                    mouseEnterDelay={0.35}
                    placement="right"
                    destroyTooltipOnHide
                    content={
                      <HoverCard>
                        <HoverCardHeader>
                          <HoverRole $role={message.role}>{message.role}</HoverRole>
                          <HoverMeta>#{index + 1}</HoverMeta>
                        </HoverCardHeader>
                        <HoverCardBody>{hoverPreview || t('chat.navigation.toc_empty')}</HoverCardBody>
                      </HoverCard>
                    }>
                    <RowButton
                      type="button"
                      onClick={() => handleSelectMessage(message.id)}
                      $active={isActive}
                      title={previewRaw ? normalizePreviewText(previewRaw) : undefined}>
                      <RoleBadge $role={message.role}>{roleLabel}</RoleBadge>
                      <RowText>
                        <RowIndex>#{index + 1}</RowIndex>
                        <RowPreview>{preview || emptyMessageLabel}</RowPreview>
                      </RowText>
                    </RowButton>
                  </Popover>
                )
              }}
            </DynamicVirtualList>
          )}
        </Panel>
      }>
      <Tooltip title={t('chat.navigation.toc')} mouseEnterDelay={0.8}>
        <NavbarIcon>
          <ListOrdered size={18} />
        </NavbarIcon>
      </Tooltip>
    </Popover>
  )
}

const Panel = styled.div`
  width: min(520px, 60vw);
  padding: 8px;
`

const PanelHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 6px 10px 6px;
`

const PanelTitle = styled.div`
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-1);
  user-select: none;
`

const PanelActions = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 6px;
`

const IconButton = styled.button`
  cursor: pointer;
  border: 1px solid transparent;
  background: transparent;
  color: var(--color-icon);
  border-radius: 8px;
  padding: 4px 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  &:hover {
    background: var(--color-background-mute);
  }
`

const EmptyState = styled.div`
  padding: 18px 10px;
  color: var(--color-text-3);
  font-size: 12px;
`

const RowButton = styled.button<{ $active: boolean }>`
  width: 100%;
  border: none;
  background: ${({ $active }) => ($active ? 'var(--color-background-mute)' : 'transparent')};
  padding: 8px 8px;
  border-radius: 8px;
  cursor: pointer;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  text-align: left;
  &:hover {
    background: var(--color-background-mute);
  }
`

const RoleBadge = styled.div<{ $role: Message['role'] }>`
  width: 18px;
  height: 18px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  line-height: 18px;
  color: var(--color-text-1);
  background: ${({ $role }) => ($role === 'user' ? 'rgba(76, 175, 80, 0.18)' : 'rgba(33, 150, 243, 0.18)')};
  flex-shrink: 0;
  margin-top: 2px;
`

const RowText = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
`

const RowIndex = styled.div`
  font-size: 11px;
  color: var(--color-text-3);
  user-select: none;
`

const RowPreview = styled.div`
  font-size: 12px;
  color: var(--color-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
`

const HoverCard = styled.div`
  max-width: min(520px, 50vw);
`

const HoverCardHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
`

const HoverRole = styled.div<{ $role: Message['role'] }>`
  font-size: 12px;
  color: var(--color-text-2);
  padding: 2px 8px;
  border-radius: 999px;
  background: ${({ $role }) => ($role === 'user' ? 'rgba(76, 175, 80, 0.18)' : 'rgba(33, 150, 243, 0.18)')};
`

const HoverMeta = styled.div`
  font-size: 12px;
  color: var(--color-text-3);
`

const HoverCardBody = styled.div`
  font-size: 12px;
  line-height: 18px;
  color: var(--color-text-2);
  white-space: pre-wrap;
`

export default React.memo(MessagesTocButton)
