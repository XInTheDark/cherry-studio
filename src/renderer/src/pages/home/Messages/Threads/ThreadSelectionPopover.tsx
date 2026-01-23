import { loggerService } from '@logger'
import { buildThreadAnchorFromSelection } from '@renderer/services/ThreadService'
import { useAppDispatch } from '@renderer/store'
import { createThreadFromMessageThunk } from '@renderer/store/thunk/threadThunk'
import type { Assistant, Topic } from '@renderer/types'
import type { ThreadAnchor } from '@renderer/types/thread'
import { Button, Input } from 'antd'
import { X } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

const logger = loggerService.withContext('ThreadSelectionPopover')

type SelectionContext = {
  rect: DOMRect
  parentMessageId: string
  parentTopicId: string
  assistantId: string
  blockId: string
  selectedText: string
  anchor: ThreadAnchor
}

const isPrintableKey = (e: KeyboardEvent): boolean => {
  if (e.ctrlKey || e.metaKey || e.altKey) return false
  if (e.key.length !== 1) return false
  return true
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

const getSafeRect = (range: Range): DOMRect | null => {
  const rect = range.getBoundingClientRect()
  if (rect && (rect.width > 0 || rect.height > 0)) return rect
  const r0 = range.getClientRects()?.[0]
  return r0 ?? null
}

const ThreadSelectionPopover: FC<{ assistant: Assistant; topic: Topic }> = ({ assistant, topic }) => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()

  const [selectionCtx, setSelectionCtx] = useState<SelectionContext | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<any>(null)

  const close = useCallback(() => {
    setSelectionCtx(null)
    setExpanded(false)
    setDraft('')
  }, [])

  const updateFromSelection = useCallback(() => {
    const sel = document.getSelection()
    if (!sel || sel.rangeCount === 0) {
      if (!expanded) setSelectionCtx(null)
      return
    }

    const range = sel.getRangeAt(0)
    if (range.collapsed) {
      if (!expanded) setSelectionCtx(null)
      return
    }

    const startEl =
      (range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement) ?? null
    const endEl =
      (range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement) ?? null
    if (!startEl || !endEl) {
      if (!expanded) setSelectionCtx(null)
      return
    }

    const blockEl = startEl.closest<HTMLElement>('[data-thread-block-id]')
    const endBlockEl = endEl.closest<HTMLElement>('[data-thread-block-id]')
    if (!blockEl || !endBlockEl || blockEl !== endBlockEl) {
      if (!expanded) setSelectionCtx(null)
      return
    }

    const messageEl = blockEl.closest<HTMLElement>('[data-thread-message-id]')
    if (!messageEl) {
      if (!expanded) setSelectionCtx(null)
      return
    }

    const parentMessageId = messageEl.dataset.threadMessageId
    const parentTopicId = messageEl.dataset.threadTopicId
    const assistantId = messageEl.dataset.threadAssistantId
    const blockId = blockEl.dataset.threadBlockId
    if (!parentMessageId || !parentTopicId || !assistantId || !blockId) {
      if (!expanded) setSelectionCtx(null)
      return
    }

    const rect = getSafeRect(range)
    if (!rect) {
      if (!expanded) setSelectionCtx(null)
      return
    }

    const anchorBase = buildThreadAnchorFromSelection(blockEl, range, { prefixLen: 48, suffixLen: 48 })
    if (!anchorBase) {
      if (!expanded) setSelectionCtx(null)
      return
    }

    const selectedText = range.toString().trim()
    const anchor: ThreadAnchor = { ...anchorBase, blockId }

    setSelectionCtx({ rect, parentMessageId, parentTopicId, assistantId, blockId, selectedText, anchor })
  }, [expanded])

  useEffect(() => {
    const onMouseUp = () => updateFromSelection()
    const onSelectionChange = () => {
      // selectionchange fires a lot; we only refresh if the popover is open.
      if (selectionCtx) updateFromSelection()
    }

    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('selectionchange', onSelectionChange)
    return () => {
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('selectionchange', onSelectionChange)
    }
  }, [updateFromSelection, selectionCtx])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!selectionCtx) return
      if (expanded) return
      if (!isPrintableKey(e)) return

      setExpanded(true)
      setDraft(e.key)
      // Avoid the typed key from doing something else (e.g. triggering page shortcuts).
      e.preventDefault()
      e.stopPropagation()
      setTimeout(() => inputRef.current?.focus?.(), 0)
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [expanded, selectionCtx])

  useEffect(() => {
    if (!expanded) return
    setTimeout(() => inputRef.current?.focus?.(), 0)
  }, [expanded])

  const popoverPos = useMemo(() => {
    if (!selectionCtx) return { left: -9999, top: -9999 }
    const margin = 10
    const desiredLeft = selectionCtx.rect.left
    const desiredTop = selectionCtx.rect.bottom + 8
    const left = clamp(desiredLeft, margin, window.innerWidth - 320 - margin)
    const top = clamp(desiredTop, margin, window.innerHeight - 220 - margin)
    return { left, top }
  }, [selectionCtx])

  const handleExpand = useCallback(() => {
    setExpanded(true)
    setTimeout(() => inputRef.current?.focus?.(), 0)
  }, [])

  const handleSend = useCallback(async () => {
    if (!selectionCtx) return
    const content = draft.trim()
    if (!content) return

    const summary = await dispatch(
      createThreadFromMessageThunk({
        parentTopicId: selectionCtx.parentTopicId,
        parentMessageId: selectionCtx.parentMessageId,
        assistantId: selectionCtx.assistantId,
        starterPrompt: content,
        anchor: selectionCtx.anchor,
        highlightedText: selectionCtx.selectedText
      }) as any
    )

    if (!summary) {
      window.toast?.error?.(t('thread.create_failed'))
      return
    }

    try {
      const sel = document.getSelection()
      sel?.removeAllRanges()
    } catch (error) {
      logger.warn('Failed to clear selection ranges:', error as Error)
    }

    close()
  }, [close, dispatch, draft, selectionCtx, t])

  if (!selectionCtx) return null

  // Don't show selection popover when multi-select mode is active.
  // (We rely on the assistant/topic props, but multi-select is global UI state; keep the popover quiet.)
  // NOTE: avoiding useSelector here keeps this component lightweight.
  if (!assistant || !topic) return null

  return (
    <Container style={popoverPos}>
      {!expanded ? (
        <Button size="small" type="primary" onClick={handleExpand}>
          {t('thread.reply_in_thread')}
        </Button>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{t('thread.reply_in_thread')}</CardTitle>
            <Button size="small" type="text" icon={<X size={14} />} onClick={close} />
          </CardHeader>
          <SelectedText title={selectionCtx.selectedText}>{selectionCtx.selectedText}</SelectedText>
          <Input.TextArea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('thread.start_placeholder')}
            autoSize={{ minRows: 2, maxRows: 6 }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
          />
          <Actions>
            <Button size="small" onClick={close}>
              {t('thread.cancel')}
            </Button>
            <Button size="small" type="primary" disabled={!draft.trim()} onClick={handleSend}>
              {t('thread.send')}
            </Button>
          </Actions>
        </Card>
      )}
    </Container>
  )
}

const Container = styled.div`
  position: fixed;
  z-index: 9998;
`

const Card = styled.div`
  width: 320px;
  padding: 10px;
  border-radius: 10px;
  background: var(--color-background);
  border: 1px solid var(--color-border-soft);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.12);
`

const CardHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
`

const CardTitle = styled.div`
  font-weight: 600;
  color: var(--color-text);
`

const SelectedText = styled.div`
  font-size: 12px;
  color: var(--color-text-3);
  background: var(--color-background-soft);
  border-radius: 8px;
  padding: 8px;
  margin-bottom: 8px;
  max-height: 60px;
  overflow: hidden;
  text-overflow: ellipsis;
`

const Actions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
`

export default ThreadSelectionPopover
