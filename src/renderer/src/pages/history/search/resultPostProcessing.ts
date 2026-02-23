import type { Message } from '@renderer/types/newMessage'

export type HistorySearchSortBy = 'relevance' | 'newest' | 'oldest'
export type HistorySearchRoleFilter = 'all' | 'user' | 'assistant'
export type HistorySearchDateRange = 'all' | '24h' | '7d' | '30d'

export interface HistorySearchPostProcessableResult {
  score: number
  createdAtMs: number
  role: Message['role']
  searchableContent: string
}

export interface HistorySearchPostProcessingOptions {
  sortBy: HistorySearchSortBy
  roleFilter: HistorySearchRoleFilter
  dateRange: HistorySearchDateRange
  exactPhraseOnly: boolean
  exactPhraseNeedle: string
  now?: number
}

const DATE_RANGE_MS: Record<Exclude<HistorySearchDateRange, 'all'>, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000
}

const sortByRelevance = <T extends HistorySearchPostProcessableResult>(a: T, b: T) =>
  b.score - a.score || b.createdAtMs - a.createdAtMs

const sortByNewest = <T extends HistorySearchPostProcessableResult>(a: T, b: T) =>
  b.createdAtMs - a.createdAtMs || b.score - a.score

const sortByOldest = <T extends HistorySearchPostProcessableResult>(a: T, b: T) =>
  a.createdAtMs - b.createdAtMs || b.score - a.score

export const deriveExactPhraseNeedle = (normalizedQuery: string, phrases: string[], terms: string[]): string => {
  if (phrases.length === 1 && terms.length === 0) {
    return phrases[0]
  }
  return normalizedQuery.replace(/"/g, ' ').replace(/\s+/g, ' ').trim()
}

export const applyHistorySearchPostProcessing = <T extends HistorySearchPostProcessableResult>(
  results: T[],
  options: HistorySearchPostProcessingOptions
): T[] => {
  let filtered = results

  if (options.roleFilter !== 'all') {
    filtered = filtered.filter((result) => result.role === options.roleFilter)
  }

  if (options.dateRange !== 'all') {
    const cutoff = (options.now ?? Date.now()) - DATE_RANGE_MS[options.dateRange]
    filtered = filtered.filter((result) => result.createdAtMs >= cutoff)
  }

  if (options.exactPhraseOnly && options.exactPhraseNeedle.length > 0) {
    filtered = filtered.filter((result) => result.searchableContent.includes(options.exactPhraseNeedle))
  }

  const sorted = [...filtered]
  if (options.sortBy === 'newest') {
    sorted.sort(sortByNewest)
  } else if (options.sortBy === 'oldest') {
    sorted.sort(sortByOldest)
  } else {
    sorted.sort(sortByRelevance)
  }

  return sorted
}
