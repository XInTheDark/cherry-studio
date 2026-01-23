import { describe, expect, it } from 'vitest'

import { buildThreadTopicId, findBestAnchorOffsets, isThreadTopicId, parseThreadTopicId } from '../ThreadService'

describe('ThreadService', () => {
  it('should build and parse thread topic ids', () => {
    const ref = {
      parentTopicId: 'topic-123',
      parentMessageId: 'msg-456',
      threadId: 'thread-789'
    }
    const topicId = buildThreadTopicId(ref)
    expect(isThreadTopicId(topicId)).toBe(true)
    expect(parseThreadTopicId(topicId)).toEqual(ref)
  })

  it('should parse nested thread topic ids (parentTopicId can contain delimiters)', () => {
    const parent = buildThreadTopicId({ parentTopicId: 'root-topic', parentMessageId: 'm1', threadId: 't1' })
    const nested = buildThreadTopicId({ parentTopicId: parent, parentMessageId: 'm2', threadId: 't2' })
    const parsed = parseThreadTopicId(nested)
    expect(parsed?.parentTopicId).toBe(parent)
    expect(parsed?.parentMessageId).toBe('m2')
    expect(parsed?.threadId).toBe('t2')
  })

  it('should find best anchor offsets by exact match', () => {
    const text = 'hello world\nhello world'
    const anchor = {
      blockId: 'b1',
      exact: 'world',
      prefix: 'hello ',
      suffix: '\n'
    }
    const offsets = findBestAnchorOffsets(text, anchor)
    expect(offsets).toEqual({ start: 6, end: 11 })
  })

  it('should fall back to offsets when exact is not found', () => {
    const text = 'abcdef'
    const anchor = {
      blockId: 'b1',
      exact: 'zzz',
      startOffset: 2,
      endOffset: 4
    }
    const offsets = findBestAnchorOffsets(text, anchor)
    expect(offsets).toEqual({ start: 2, end: 4 })
  })
})
