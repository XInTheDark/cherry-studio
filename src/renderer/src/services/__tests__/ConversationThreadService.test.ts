import { TopicType } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import ConversationThreadService from '../ConversationThreadService'

describe('ConversationThreadService helpers', () => {
  it('buildHomeThreadRecord should normalize home topic metadata', () => {
    const record = ConversationThreadService.buildHomeThreadRecord(
      {
        id: 'topic-1',
        assistantId: 'assistant-a',
        type: TopicType.Chat,
        name: '  Topic Name  ',
        createdAt: '2026-02-21T00:00:00.000Z',
        updatedAt: '2026-02-21T01:00:00.000Z',
        pinned: true,
        isNameManuallyEdited: true,
        messages: []
      },
      'assistant-a'
    )

    expect(record).toEqual({
      id: 'topic-1',
      topicId: 'topic-1',
      scope: 'home',
      assistantId: 'assistant-a',
      topicType: 'chat',
      name: 'Topic Name',
      createdAt: '2026-02-21T00:00:00.000Z',
      updatedAt: '2026-02-21T01:00:00.000Z',
      pinned: true,
      isNameManuallyEdited: true
    })
  })

  it('buildSessionThreadRecord should map agent session metadata to a session-scoped record', () => {
    const record = ConversationThreadService.buildSessionThreadRecord('agent-1', {
      id: 'session-1',
      name: 'Session Name',
      created_at: '2026-02-20T10:00:00.000Z',
      updated_at: '2026-02-20T12:00:00.000Z',
      agent_id: 'agent-1'
    })

    expect(record).toEqual({
      id: 'agent-session:session-1',
      topicId: 'agent-session:session-1',
      scope: 'session',
      assistantId: 'agent-1',
      topicType: 'session',
      name: 'Session Name',
      createdAt: '2026-02-20T10:00:00.000Z',
      updatedAt: '2026-02-20T12:00:00.000Z'
    })
  })
})
