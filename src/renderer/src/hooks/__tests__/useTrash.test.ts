import type { TrashedTopic } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import { selectTrashEvictions } from '../trashUtils'

function makeTrashed(id: string, trashedAt: string): TrashedTopic {
  return {
    id,
    assistantId: 'a1',
    trashedAt,
    topic: {
      id,
      assistantId: 'a1',
      name: `Topic ${id}`,
      createdAt: trashedAt,
      updatedAt: trashedAt,
      messages: []
    }
  }
}

describe('selectTrashEvictions', () => {
  it('returns empty array when trash size is within max', () => {
    const trashed = [makeTrashed('t1', '2026-02-02T00:00:00.000Z')]
    expect(selectTrashEvictions(trashed, 50)).toEqual([])
  })

  it('evicts oldest items beyond max size', () => {
    const trashed = [
      makeTrashed('t1', '2026-02-02T00:00:01.000Z'),
      makeTrashed('t2', '2026-02-02T00:00:02.000Z'),
      makeTrashed('t3', '2026-02-02T00:00:03.000Z')
    ]

    // max=2 -> evict oldest (t1)
    expect(selectTrashEvictions(trashed, 2).map((t) => t.id)).toEqual(['t1'])
  })

  it('evicts everything when max size is 0', () => {
    const trashed = [makeTrashed('t1', '2026-02-02T00:00:01.000Z'), makeTrashed('t2', '2026-02-02T00:00:02.000Z')]
    expect(selectTrashEvictions(trashed, 0).map((t) => t.id)).toEqual(['t1', 't2'])
  })
})
