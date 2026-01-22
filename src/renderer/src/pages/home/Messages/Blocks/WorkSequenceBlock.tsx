import ThinkingEffect from '@renderer/components/ThinkingEffect'
import type { MessageBlock, ThinkingMessageBlock, ToolMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { Collapse } from 'antd'
import { memo, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import ThinkingBlock from './ThinkingBlock'
import ToolBlock from './ToolBlock'

interface Props {
  blocks: MessageBlock[]
  /**
   * True when this "work sequence" is the tail of an in-progress assistant message,
   * so the elapsed timer should tick until completion.
   */
  isRunning: boolean
}

const parseIsoMillis = (value?: string) => {
  if (!value) return 0
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

const formatSeconds1dp = (millis: number) => {
  const safe = typeof millis === 'number' && Number.isFinite(millis) ? millis : 0
  // Keep the UI from showing "0.0s" for very short sequences.
  const clamped = Math.max(0, safe)
  const display = Math.max(clamped, 100)
  return (display / 1000).toFixed(1)
}

const isRenderableWorkBlock = (block: MessageBlock) => {
  if (block.type === MessageBlockType.THINKING) {
    return Boolean((block as ThinkingMessageBlock).content)
  }
  if (block.type === MessageBlockType.TOOL) {
    return Boolean((block as ToolMessageBlock).metadata?.rawMcpToolResponse)
  }
  return false
}

const WorkSequenceBlock: React.FC<Props> = ({ blocks, isRunning }) => {
  const { t } = useTranslation()
  const [activeKey, setActiveKey] = useState<'work' | ''>('')
  const [nowMillis, setNowMillis] = useState(() => Date.now())

  const renderableBlocks = useMemo(() => blocks.filter(isRenderableWorkBlock), [blocks])
  const hasRenderableBlocks = renderableBlocks.length > 0

  const toolCount = useMemo(() => blocks.filter((b) => b.type === MessageBlockType.TOOL).length, [blocks])
  const thoughtCount = useMemo(() => blocks.filter((b) => b.type === MessageBlockType.THINKING).length, [blocks])

  const startMillis = useMemo(() => parseIsoMillis(blocks[0]?.createdAt), [blocks])
  const endMillisStatic = useMemo(() => {
    const last = blocks[blocks.length - 1]
    return parseIsoMillis(last?.updatedAt ?? last?.createdAt)
  }, [blocks])

  useEffect(() => {
    if (!isRunning) return
    const timer = setInterval(() => setNowMillis(Date.now()), 100)
    return () => clearInterval(timer)
  }, [isRunning])

  const endMillis = isRunning ? nowMillis : endMillisStatic
  const elapsedMillis = Math.max(0, endMillis - startMillis)
  const elapsedSeconds = useMemo(() => formatSeconds1dp(elapsedMillis), [elapsedMillis])

  const headerTitle = useMemo(() => {
    const durationText = isRunning
      ? t('chat.work_sequence.working_for', { seconds: elapsedSeconds })
      : t('chat.work_sequence.worked_for', { seconds: elapsedSeconds })

    const parts: string[] = [durationText]
    if (toolCount > 0) parts.push(t('chat.work_sequence.tool_count', { count: toolCount }))
    if (thoughtCount > 0) parts.push(t('chat.work_sequence.thought_count', { count: thoughtCount }))

    return parts.join(' · ')
  }, [elapsedSeconds, isRunning, t, thoughtCount, toolCount])

  const headerContent = useMemo(() => {
    // Provide compact, non-sensitive, line-based status for the header "thinking" animation.
    // (ThinkingEffect scrolls lines while the message is running and the panel is collapsed.)
    const lines: string[] = []
    for (const block of blocks) {
      if (block.type === MessageBlockType.TOOL) {
        const toolBlock = block as ToolMessageBlock
        const toolName =
          toolBlock.toolName ??
          (toolBlock.metadata?.rawMcpToolResponse as any)?.tool?.name ??
          toolBlock.toolId ??
          'tool'
        lines.push(`Tool: ${toolName}`)
      } else if (block.type === MessageBlockType.THINKING) {
        lines.push('Thought')
      }
    }
    return lines.join('\n')
  }, [blocks])

  // Consider the sequence "active" while any child block is still streaming/processing.
  // This is used only for styling and does not affect timing, which is controlled by isRunning.
  const isActive = useMemo(
    () => blocks.some((b) => b.status === MessageBlockStatus.PROCESSING || b.status === MessageBlockStatus.STREAMING),
    [blocks]
  )

  if (!hasRenderableBlocks) return null

  return (
    <CollapseContainer
      activeKey={activeKey}
      size="small"
      onChange={() => setActiveKey((key) => (key ? '' : 'work'))}
      className="message-work-sequence-container"
      ghost
      items={[
        {
          key: 'work',
          label: (
            <ThinkingEffect
              expanded={activeKey === 'work'}
              isThinking={isRunning || isActive}
              thinkingTimeText={headerTitle}
              content={headerContent}
            />
          ),
          children: (
            <SequenceBody>
              {renderableBlocks.map((block) => {
                if (block.type === MessageBlockType.TOOL) {
                  return <ToolBlock key={block.id} block={block as ToolMessageBlock} />
                }
                if (block.type === MessageBlockType.THINKING) {
                  return <ThinkingBlock key={block.id} block={block as ThinkingMessageBlock} />
                }
                return null
              })}
            </SequenceBody>
          ),
          showArrow: false
        }
      ]}
    />
  )
}

const CollapseContainer = styled(Collapse)`
  margin-bottom: 15px;
  .ant-collapse-header {
    padding: 0 !important;
  }
  .ant-collapse-content-box {
    padding: 16px !important;
    border-width: 0 0.5px 0.5px 0.5px;
    border-style: solid;
    border-color: var(--color-border);
    border-radius: 0 0 12px 12px;
  }
`

const SequenceBody = styled.div`
  padding-top: 10px;
`

export default memo(WorkSequenceBlock)
