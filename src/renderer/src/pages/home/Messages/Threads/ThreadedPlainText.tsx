import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { findBestAnchorOffsets, wrapThreadHighlightSafely } from '@renderer/services/ThreadService'
import type { ThreadAnchor } from '@renderer/types/thread'
import type { FC } from 'react'
import { useCallback, useEffect, useRef } from 'react'

type ThreadHighlight = {
  parentMessageId: string
  threadTopicId: string
  starterPrompt: string
  anchor: ThreadAnchor
}

const ThreadedPlainText: FC<{ text: string; threadHighlights?: ThreadHighlight[] }> = ({ text, threadHighlights }) => {
  const ref = useRef<HTMLParagraphElement | null>(null)
  const lastHoverElRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const root = ref.current
    if (!root) return

    // Clear any old highlights.
    const existing = root.querySelectorAll<HTMLElement>('[data-thread-highlight="1"]')
    existing.forEach((el) => {
      const parent = el.parentNode
      if (!parent) return
      while (el.firstChild) parent.insertBefore(el.firstChild, el)
      parent.removeChild(el)
    })

    if (!threadHighlights || threadHighlights.length === 0) return

    const contentText = root.textContent ?? ''
    for (const hl of threadHighlights) {
      const offsets = findBestAnchorOffsets(contentText, hl.anchor)
      if (!offsets) continue

      try {
        wrapThreadHighlightSafely(root, offsets, {
          threadTopicId: hl.threadTopicId,
          parentMessageId: hl.parentMessageId,
          starterPrompt: hl.starterPrompt
        })
      } catch {
        // ignore
      }
    }
  }, [text, threadHighlights])

  const handleMouseOver = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement | null
    if (!target) return
    const el = target.closest<HTMLElement>('[data-thread-highlight="1"]')
    if (!el) {
      if (lastHoverElRef.current) {
        lastHoverElRef.current = null
        EventEmitter.emit(EVENT_NAMES.THREAD_HIGHLIGHT_LEAVE)
      }
      return
    }
    if (lastHoverElRef.current === el) return
    lastHoverElRef.current = el

    const prompt = el.dataset.threadStarterPrompt ?? ''
    const rect = el.getBoundingClientRect()
    EventEmitter.emit(EVENT_NAMES.THREAD_HIGHLIGHT_HOVER, { prompt, rect })
  }, [])

  const handleMouseLeave = useCallback(() => {
    lastHoverElRef.current = null
    EventEmitter.emit(EVENT_NAMES.THREAD_HIGHLIGHT_LEAVE)
  }, [])

  const handleClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement | null
    if (!target) return
    const el = target.closest<HTMLElement>('[data-thread-highlight="1"]')
    if (!el) return

    const parentMessageId = el.dataset.threadParentMessageId
    const threadTopicId = el.dataset.threadTopicId
    if (!parentMessageId || !threadTopicId) return

    e.preventDefault()
    e.stopPropagation()
    EventEmitter.emit(EVENT_NAMES.OPEN_THREAD_PANEL, { parentMessageId, threadTopicId })
  }, [])

  return (
    <p
      ref={ref}
      className="markdown"
      style={{ whiteSpace: 'pre-wrap' }}
      onMouseOver={handleMouseOver}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}>
      {text}
    </p>
  )
}

export default ThreadedPlainText
