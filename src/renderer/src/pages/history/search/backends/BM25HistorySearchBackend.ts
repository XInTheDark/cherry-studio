import { normalizeSearchString, tokenizeForSearch } from '../queryParser'
import type {
  HistorySearchBackend,
  HistorySearchBackendRequest,
  HistorySearchDocument,
  HistorySearchHit
} from '../types'

const BM25_DEFAULT_K1 = 1.2
const BM25_DEFAULT_B = 0.75
const BM25_PHRASE_BOOST = 3
const BM25_EXACT_QUERY_BOOST = 2
const BM25_FULL_COVERAGE_BOOST = 1.5

interface BM25Options {
  k1?: number
  b?: number
}

interface PreparedDocument {
  id: string
  normalizedContent: string
  termFrequency: Map<string, number>
  termCount: number
}

const countOccurrences = (text: string, target: string): number => {
  if (!target.length) {
    return 0
  }
  let count = 0
  let from = 0
  while (from < text.length) {
    const index = text.indexOf(target, from)
    if (index === -1) {
      break
    }
    count += 1
    from = index + target.length
  }
  return count
}

const prepareDocuments = (documents: HistorySearchDocument[]): PreparedDocument[] =>
  documents.map((document) => {
    const normalizedContent = normalizeSearchString(document.content)
    const tokens = tokenizeForSearch(normalizedContent)
    const termFrequency = new Map<string, number>()

    for (const token of tokens) {
      termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1)
    }

    return {
      id: document.id,
      normalizedContent,
      termFrequency,
      termCount: tokens.length
    }
  })

const computeDocumentFrequencies = (documents: PreparedDocument[], queryTokens: string[]): Map<string, number> => {
  const frequencies = new Map<string, number>()

  for (const token of queryTokens) {
    let count = 0
    for (const document of documents) {
      if (document.termFrequency.has(token)) {
        count += 1
      }
    }
    frequencies.set(token, count)
  }

  return frequencies
}

const computeIdf = (documentCount: number, documentFrequency: number): number => {
  if (documentFrequency <= 0) {
    return 0
  }
  return Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5))
}

const rankDocument = (
  document: PreparedDocument,
  request: HistorySearchBackendRequest,
  documentCount: number,
  averageDocumentLength: number,
  documentFrequencies: Map<string, number>,
  options: Required<BM25Options>
): HistorySearchHit | null => {
  const { parsedQuery } = request

  const phraseCounts = parsedQuery.phrases.map((phrase) => ({
    phrase,
    count: countOccurrences(document.normalizedContent, phrase)
  }))

  // Quoted phrases are treated as hard constraints to keep phrase search precise.
  if (parsedQuery.phrases.length > 0 && phraseCounts.some((item) => item.count === 0)) {
    return null
  }

  let score = 0
  const matchedTerms: string[] = []

  for (const token of parsedQuery.tokens) {
    const termFrequency = document.termFrequency.get(token) ?? 0
    if (termFrequency <= 0) {
      continue
    }
    matchedTerms.push(token)

    const df = documentFrequencies.get(token) ?? 0
    if (df === 0) {
      continue
    }
    const idf = computeIdf(documentCount, df)

    const numerator = termFrequency * (options.k1 + 1)
    const denominator =
      termFrequency + options.k1 * (1 - options.b + (options.b * document.termCount) / averageDocumentLength)
    score += idf * (numerator / denominator)
  }

  const matchedPhrases = phraseCounts.filter((item) => item.count > 0).map((item) => item.phrase)

  if (parsedQuery.tokens.length > 0 && matchedTerms.length === 0 && matchedPhrases.length === 0) {
    return null
  }

  if (matchedPhrases.length > 0) {
    score += phraseCounts.reduce((sum, item) => sum + item.count * BM25_PHRASE_BOOST, 0)
  }

  if (parsedQuery.tokens.length > 1 && matchedTerms.length === parsedQuery.tokens.length) {
    score += BM25_FULL_COVERAGE_BOOST
  }

  if (parsedQuery.normalized.length > 0 && document.normalizedContent.includes(parsedQuery.normalized)) {
    score += BM25_EXACT_QUERY_BOOST
  }

  if (score <= 0) {
    return null
  }

  return {
    documentId: document.id,
    score,
    matchedTerms,
    matchedPhrases
  }
}

export const createBM25HistorySearchBackend = (options: BM25Options = {}): HistorySearchBackend => {
  const config: Required<BM25Options> = {
    k1: options.k1 ?? BM25_DEFAULT_K1,
    b: options.b ?? BM25_DEFAULT_B
  }

  return {
    id: 'bm25',
    search: (request) => {
      const documents = prepareDocuments(request.documents)
      if (documents.length === 0 || request.parsedQuery.isEmpty) {
        return []
      }

      const averageDocumentLength =
        documents.reduce((sum, document) => sum + document.termCount, 0) / Math.max(1, documents.length)
      const safeAverageDocumentLength = Math.max(averageDocumentLength, 1)
      const documentFrequencies = computeDocumentFrequencies(documents, request.parsedQuery.tokens)

      const hits = documents
        .map((document) =>
          rankDocument(document, request, documents.length, safeAverageDocumentLength, documentFrequencies, config)
        )
        .filter((hit): hit is HistorySearchHit => hit !== null)
        .sort((a, b) => b.score - a.score)

      return request.limit ? hits.slice(0, request.limit) : hits
    }
  }
}
