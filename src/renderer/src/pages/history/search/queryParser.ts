import type { ParsedHistorySearchQuery } from './types'

const QUOTED_PHRASE_PATTERN = /"([^"]+)"/g
const SEARCH_TOKEN_PATTERN = /[\p{L}\p{N}_]+/gu

export const normalizeSearchString = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim()

export const tokenizeForSearch = (value: string): string[] => {
  const normalized = normalizeSearchString(value)
  if (!normalized) {
    return []
  }
  return normalized.match(SEARCH_TOKEN_PATTERN) ?? []
}

const unique = (values: string[]) => Array.from(new Set(values))

export const parseHistorySearchQuery = (query: string): ParsedHistorySearchQuery => {
  const normalized = normalizeSearchString(query)
  if (!normalized) {
    return {
      raw: query,
      normalized,
      terms: [],
      phrases: [],
      tokens: [],
      isEmpty: true
    }
  }

  const phraseMatches = Array.from(normalized.matchAll(QUOTED_PHRASE_PATTERN))
  const phrases = unique(
    phraseMatches.map((match) => normalizeSearchString(match[1])).filter((phrase) => phrase.length > 0)
  )

  const remainingText = normalized.replace(QUOTED_PHRASE_PATTERN, ' ')
  const terms = unique(tokenizeForSearch(remainingText))
  const phraseTokens = phrases.flatMap((phrase) => tokenizeForSearch(phrase))
  const tokens = unique([...terms, ...phraseTokens])

  return {
    raw: query,
    normalized,
    terms,
    phrases,
    tokens,
    isEmpty: tokens.length === 0 && phrases.length === 0
  }
}

export const getHighlightTargets = (parsedQuery: ParsedHistorySearchQuery): string[] =>
  unique([...parsedQuery.phrases, ...parsedQuery.tokens]).filter((target) => target.length > 0)
