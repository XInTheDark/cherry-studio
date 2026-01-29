import { describe, expect, it } from 'vitest'

import { isCanvasChatTopicId, parseCanvasChatTopicId } from '../CanvasChatService'

describe('CanvasChatService helpers', () => {
  it('should recognize canvas chat topic ids', () => {
    expect(isCanvasChatTopicId('canvas__abc__def')).toBe(true)
    expect(isCanvasChatTopicId('thread__abc')).toBe(false)
    expect(isCanvasChatTopicId('abc')).toBe(false)
  })

  it('should parse canvas chat topic ids', () => {
    expect(parseCanvasChatTopicId('canvas__canvas1__chat1')).toEqual({ canvasId: 'canvas1', chatId: 'chat1' })
    expect(parseCanvasChatTopicId('canvas__onlyone')).toBeNull()
    expect(parseCanvasChatTopicId('thread__canvas1__chat1')).toBeNull()
  })
})
