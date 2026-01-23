import { loggerService } from '@logger'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { buildThreadAnchorFromSelection } from '@renderer/services/ThreadService'
import type { ThreadAnchor } from '@renderer/types/thread'
import type { FC } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

const logger = loggerService.withContext('ThreadSelectionTracker')

type SelectionContext = {
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

const isTypingIntoEditable = (): boolean => {
  const el = document.activeElement as HTMLElement | null
  if (!el) return false
  if (el.tagName === 'TEXTAREA') return true
  if (el.tagName === 'INPUT') return true
  if ((el as any).isContentEditable) return true
  return false
}

const getSafeRect = (range: Range): DOMRect | null => {
  const rect = range.getBoundingClientRect()
  if (rect && (rect.width > 0 || rect.height > 0)) return rect
  const r0 = range.getClientRects()?.[0]
  return r0 ?? null
}

// No UI: this is just the "selection + typing opens thread composer" behavior.
const ThreadSelectionTracker: FC = () => {
  const [selectionCtx, setSelectionCtx] = useState<SelectionContext | null>(null)

  const selectionCtxRef = useRef<SelectionContext | null>(null)
  useEffect(() => {
    selectionCtxRef.current = selectionCtx
  }, [selectionCtx])

  const pendingDraftTargetRef = useRef<{ parentTopicId: string; parentMessageId: string } | null>(null)
  const pendingDraftUntilRef = useRef<number>(0)

  const updateFromSelection = useCallback(() => {
    const sel = document.getSelection()
    if (!sel || sel.rangeCount === 0) {
      setSelectionCtx(null)
      return
    }

    const range = sel.getRangeAt(0)
    if (range.collapsed) {
      setSelectionCtx(null)
      return
    }

    // If selection doesn't have a real rect, don't attach threads to it.
    if (!getSafeRect(range)) {
      setSelectionCtx(null)
      return
    }

    const startEl =
      (range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement) ?? null
    const endEl =
      (range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement) ?? null
    if (!startEl || !endEl) {
      setSelectionCtx(null)
      return
    }

    const blockEl = startEl.closest<HTMLElement>('[data-thread-block-id]')
    const endBlockEl = endEl.closest<HTMLElement>('[data-thread-block-id]')
    if (!blockEl || !endBlockEl || blockEl !== endBlockEl) {
      // v1: only allow main-text selection within a single block.
      setSelectionCtx(null)
      return
    }

    const messageEl = blockEl.closest<HTMLElement>('[data-thread-message-id]')
    if (!messageEl) {
      setSelectionCtx(null)
      return
    }

    const parentMessageId = messageEl.dataset.threadMessageId
    const parentTopicId = messageEl.dataset.threadTopicId
    const assistantId = messageEl.dataset.threadAssistantId
    const blockId = blockEl.dataset.threadBlockId
    if (!parentMessageId || !parentTopicId || !assistantId || !blockId) {
      setSelectionCtx(null)
      return
    }

    const selectedText = sel.toString().trim()
    if (!selectedText) {
      setSelectionCtx(null)
      return
    }

    const anchorBase = buildThreadAnchorFromSelection(blockEl, range, { prefixLen: 48, suffixLen: 48 })
    if (!anchorBase) {
      setSelectionCtx(null)
      return
    }

    const anchor: ThreadAnchor = { ...anchorBase, blockId }

    setSelectionCtx({
      parentMessageId,
      parentTopicId,
      assistantId,
      blockId,
      selectedText,
      anchor
    })
  }, [])

  useEffect(() => {
    const onMouseUp = () => updateFromSelection()
    const onSelectionChange = () => updateFromSelection()
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('selectionchange', onSelectionChange)
    return () => {
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('selectionchange', onSelectionChange)
    }
  }, [updateFromSelection])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const ctx = selectionCtxRef.current
      if (!isPrintableKey(e)) return
      if (isTypingIntoEditable()) return

      // If we just opened the thread sidebar and the textarea isn't focused yet,
      // buffer a couple of keystrokes so typing feels continuous.
      const now = Date.now()
      const pending = pendingDraftTargetRef.current
      if (!ctx && pending && now < pendingDraftUntilRef.current) {
        EventEmitter.emit(EVENT_NAMES.THREAD_STARTER_APPEND_DRAFT, {
          parentTopicId: pending.parentTopicId,
          parentMessageId: pending.parentMessageId,
          key: e.key
        })
        e.preventDefault()
        e.stopPropagation()
        return
      }

      if (!ctx) return

      // Open thread sidebar and focus the composer, seeded with the typed character.
      EventEmitter.emit(EVENT_NAMES.OPEN_THREAD_PANEL, {
        parentTopicId: ctx.parentTopicId,
        assistantId: ctx.assistantId,
        parentMessageId: ctx.parentMessageId,
        focusComposer: true,
        draft: e.key,
        anchor: ctx.anchor,
        selectedText: ctx.selectedText
      })

      // Avoid the keypress doing something else.
      e.preventDefault()
      e.stopPropagation()

      pendingDraftTargetRef.current = { parentTopicId: ctx.parentTopicId, parentMessageId: ctx.parentMessageId }
      pendingDraftUntilRef.current = Date.now() + 800

      try {
        const sel = document.getSelection()
        sel?.removeAllRanges()
      } catch (error) {
        logger.warn('Failed to clear selection ranges after opening thread composer:', error as Error)
      } finally {
        setSelectionCtx(null)
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  return null
}

export default ThreadSelectionTracker
