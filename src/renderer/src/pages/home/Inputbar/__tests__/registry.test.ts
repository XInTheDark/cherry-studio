import { TopicType } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import { getInputbarConfig } from '../registry'

describe('inputbar registry', () => {
  it('enables drag and drop in mini window scope', () => {
    const config = getInputbarConfig('mini-window')
    expect(config.enableDragDrop).toBe(true)
  })

  it('keeps drag and drop enabled for chat and session scopes', () => {
    expect(getInputbarConfig(TopicType.Chat).enableDragDrop).toBe(true)
    expect(getInputbarConfig(TopicType.Session).enableDragDrop).toBe(true)
  })
})
