import type { MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

import { groupSimilarBlocks } from '../index'

const baseBlock = {
  messageId: 'm1',
  createdAt: '2026-01-22T00:00:00.000Z',
  status: MessageBlockStatus.SUCCESS
}

const toolBlock = (id: string): MessageBlock =>
  ({
    ...baseBlock,
    id,
    type: MessageBlockType.TOOL,
    toolId: `tool-${id}`
  }) as any

const thinkingBlock = (id: string): MessageBlock =>
  ({
    ...baseBlock,
    id,
    type: MessageBlockType.THINKING,
    content: `thinking-${id}`,
    thinking_millsec: 123
  }) as any

const mainTextBlock = (id: string): MessageBlock =>
  ({
    ...baseBlock,
    id,
    type: MessageBlockType.MAIN_TEXT,
    content: `text-${id}`
  }) as any

describe('groupSimilarBlocks', () => {
  it('groups consecutive tool/thinking blocks when enabled (including length-1 sequences)', () => {
    const blocks = [toolBlock('t1'), thinkingBlock('th1'), toolBlock('t2')]
    const grouped = groupSimilarBlocks(blocks, { workSequenceAutoCollapse: true })

    expect(grouped).toHaveLength(1)
    expect(Array.isArray(grouped[0])).toBe(true)
    expect((grouped[0] as MessageBlock[]).map((b) => b.id)).toEqual(['t1', 'th1', 't2'])
  })

  it('does not group tool/thinking blocks when disabled', () => {
    const blocks = [toolBlock('t1'), thinkingBlock('th1'), toolBlock('t2')]
    const grouped = groupSimilarBlocks(blocks, { workSequenceAutoCollapse: false })

    expect(grouped).toHaveLength(3)
    expect(Array.isArray(grouped[0])).toBe(false)
    expect((grouped as MessageBlock[]).map((b) => b.id)).toEqual(['t1', 'th1', 't2'])
  })

  it('breaks groups on non tool/thinking blocks (e.g. main text)', () => {
    const blocks = [toolBlock('t1'), thinkingBlock('th1'), mainTextBlock('m1'), toolBlock('t2')]
    const grouped = groupSimilarBlocks(blocks, { workSequenceAutoCollapse: true })

    expect(grouped).toHaveLength(3)
    expect(Array.isArray(grouped[0])).toBe(true)
    expect((grouped[0] as MessageBlock[]).map((b) => b.id)).toEqual(['t1', 'th1'])
    expect(Array.isArray(grouped[1])).toBe(false)
    expect((grouped[1] as MessageBlock).id).toBe('m1')
    expect(Array.isArray(grouped[2])).toBe(true)
    expect((grouped[2] as MessageBlock[]).map((b) => b.id)).toEqual(['t2'])
  })
})
