import type { TrashedTopic } from '@renderer/types'

export const TRASH_MAX_TOPICS = 50

export function selectTrashEvictions(trashed: TrashedTopic[], maxSize: number): TrashedTopic[] {
  if (maxSize <= 0) {
    return [...trashed]
  }

  if (trashed.length <= maxSize) {
    return []
  }

  // `trashedAt` is ISO8601, so string sort matches chronological order.
  const oldestFirst = [...trashed].sort((a, b) => a.trashedAt.localeCompare(b.trashedAt))
  return oldestFirst.slice(0, oldestFirst.length - maxSize)
}
