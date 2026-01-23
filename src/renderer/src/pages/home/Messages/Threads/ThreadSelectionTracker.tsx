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

  const computeSelectionContext = useCallback((): SelectionContext | null => {
    const sel = document.getSelection()
    if (!sel || sel.rangeCount === 0) {
      return null
    }

    const range = sel.getRangeAt(0)
    if (range.collapsed) {
      return null
    }

    // If selection doesn't have a real rect, don't attach threads to it.
    if (!getSafeRect(range)) {
      return null
    }

    const startEl =
      (range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement) ?? null
    const endEl =
      (range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement) ?? null
    if (!startEl || !endEl) {
      return null
    }

    const blockEl = startEl.closest<HTMLElement>('[data-thread-block-id]')
    const endBlockEl = endEl.closest<HTMLElement>('[data-thread-block-id]')
    if (!blockEl || !endBlockEl || blockEl !== endBlockEl) {
      // v1: only allow main-text selection within a single block.
      return null
    }

    const messageEl = blockEl.closest<HTMLElement>('[data-thread-message-id]')
    if (!messageEl) {
      return null
    }

    const parentMessageId = messageEl.dataset.threadMessageId
    const parentTopicId = messageEl.dataset.threadTopicId
    const assistantId = messageEl.dataset.threadAssistantId
    const blockId = blockEl.dataset.threadBlockId
    if (!parentMessageId || !parentTopicId || !assistantId || !blockId) {
      return null
    }

    const selectedText = sel.toString().trim()
    if (!selectedText) {
      return null
    }

    const anchorBase = buildThreadAnchorFromSelection(blockEl, range, { prefixLen: 48, suffixLen: 48 })
    if (!anchorBase) {
      return null
    }

    const anchor: ThreadAnchor = { ...anchorBase, blockId }

    return {
      parentMessageId,
      parentTopicId,
      assistantId,
      blockId,
      selectedText,
      anchor
    }
  }, [])

  const updateFromSelection = useCallback(() => {
    const ctx = computeSelectionContext()
    setSelectionCtx(ctx)

    // A new, valid selection should reset the buffered-typing window so we don't
    // accidentally consume keystrokes meant for the next selection flow.
    if (ctx) {
      pendingDraftTargetRef.current = null
      pendingDraftUntilRef.current = 0
    }
  }, [computeSelectionContext])

  useEffect(() => {
    const onMouseUp = () => updateFromSelection()
    const onPointerUp = () => updateFromSelection()
    const onSelectionChange = () => updateFromSelection()
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('selectionchange', onSelectionChange)
    return () => {
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('pointerup', onPointerUp)
      document.removeEventListener('selectionchange', onSelectionChange)
    }
  }, [updateFromSelection])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isPrintableKey(e)) return
      const ctx = selectionCtxRef.current ?? computeSelectionContext()

      // If we just opened the thread sidebar and the textarea isn't focused yet,
      // buffer a couple of keystrokes so typing feels continuous.
      const now = Date.now()
      const pending = pendingDraftTargetRef.current
      if (!ctx && pending && now < pendingDraftUntilRef.current) {
        // NOTE: During this small window we intentionally intercept typing even if the
        // main input is focused, since the user is in the "selection -> type" flow.
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
      // If a selection exists in message content, typing should always open a thread
      // (even if some input remains focused).

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
  }, [computeSelectionContext])

  return null
}

export default ThreadSelectionTracker
