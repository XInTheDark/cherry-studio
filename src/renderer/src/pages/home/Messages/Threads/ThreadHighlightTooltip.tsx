import { loggerService } from '@logger'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { Tooltip } from 'antd'
import type { FC } from 'react'
import { useEffect, useMemo, useState } from 'react'
import styled from 'styled-components'

const logger = loggerService.withContext('ThreadHighlightTooltip')

type HoverPayload = {
  prompt: string
  rect: DOMRect
}

// A small singleton tooltip that can anchor to arbitrary DOM nodes (our injected highlight spans).
const ThreadHighlightTooltip: FC = () => {
  const [hover, setHover] = useState<HoverPayload | null>(null)

  useEffect(() => {
    const unsubHover = EventEmitter.on(EVENT_NAMES.THREAD_HIGHLIGHT_HOVER, (payload: HoverPayload) => {
      setHover(payload)
    })
    const unsubLeave = EventEmitter.on(EVENT_NAMES.THREAD_HIGHLIGHT_LEAVE, () => setHover(null))
    return () => {
      unsubHover()
      unsubLeave()
    }
  }, [])

  const anchorStyle = useMemo(() => {
    if (!hover) return { left: -9999, top: -9999 }
    const desiredX = hover.rect.left + hover.rect.width / 2
    const desiredY = hover.rect.top

    const container = document.getElementById('chat-main')
    if (!container) return { left: desiredX, top: desiredY }

    const r = container.getBoundingClientRect()
    // Keep tooltip anchor within the chat viewport so it can't "escape" the UI.
    const margin = 8
    const x = Math.min(r.right - margin, Math.max(r.left + margin, desiredX))
    const y = Math.min(r.bottom - margin, Math.max(r.top + margin, desiredY))
    return { left: x, top: y }
  }, [hover])

  const title = hover?.prompt?.trim() ? hover.prompt : ''

  if (!hover || !title) return null

  return (
    <Tooltip
      title={title}
      open={true}
      placement="top"
      destroyTooltipOnHide
      getPopupContainer={() => document.getElementById('chat-main') ?? document.body}>
      <Anchor
        onMouseEnter={() => {
          // keep open
        }}
        onMouseLeave={() => {
          // If the highlight span goes away during streaming, ensure we don't keep a stale tooltip.
          try {
            setHover(null)
          } catch (error) {
            logger.warn('Failed to clear hover tooltip state:', error as Error)
          }
        }}
        style={anchorStyle}
      />
    </Tooltip>
  )
}

const Anchor = styled.span`
  position: fixed;
  width: 1px;
  height: 1px;
  pointer-events: none;
  z-index: 9999;
`

export default ThreadHighlightTooltip
