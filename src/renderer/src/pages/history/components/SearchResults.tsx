import { LoadingIcon } from '@renderer/components/Icons'
import db from '@renderer/databases'
import useScrollPosition from '@renderer/hooks/useScrollPosition'
import {
  applyHistorySearchPostProcessing,
  deriveExactPhraseNeedle,
  getHighlightTargets,
  type HistorySearchDateRange,
  historySearchEngine,
  type HistorySearchRoleFilter,
  type HistorySearchSortBy,
  normalizeSearchString
} from '@renderer/pages/history/search'
import { isThreadTopicId, parseThreadTopicId } from '@renderer/services/ThreadService'
import { selectTopicsMap } from '@renderer/store/assistants'
import type { Topic } from '@renderer/types'
import { type Message, type MessageBlock, MessageBlockType } from '@renderer/types/newMessage'
import { List, Select, Spin, Switch, Typography } from 'antd'
import { useLiveQuery } from 'dexie-react-hooks'
import type { FC } from 'react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSelector } from 'react-redux'
import styled from 'styled-components'

const { Text, Title } = Typography

type SearchResult = {
  message: Message
  topic: Topic
  content: string
  snippet: string
  score: number
  role: Message['role']
  createdAtMs: number
  searchableContent: string
}

interface Props extends React.HTMLAttributes<HTMLDivElement> {
  keywords: string
  onMessageClick: (message: Message) => void
  onTopicClick: (topic: Topic) => void
}

const SEARCH_SNIPPET_CONTEXT_LINES = 1
const SEARCH_SNIPPET_MAX_LINES = 12
const SEARCH_SNIPPET_MAX_LINE_LENGTH = 160
const SEARCH_SNIPPET_LINE_FRAGMENT_RADIUS = 40
const SEARCH_SNIPPET_MAX_LINE_FRAGMENTS = 3

const stripMarkdownFormatting = (text: string) => {
  return text
    .replace(/```(?:[^\n]*\n)?([\s\S]*?)```/g, '$1')
    .replace(/!\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/#+\s/g, '')
    .replace(/<[^>]*>/g, '')
}

const normalizeText = (text: string) => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const mergeRanges = (ranges: Array<[number, number]>) => {
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (!last || range[0] > last[1] + 1) {
      merged.push([range[0], range[1]])
      continue
    }
    last[1] = Math.max(last[1], range[1])
  }
  return merged
}

const buildLineSnippet = (line: string, regexes: RegExp[]) => {
  if (line.length <= SEARCH_SNIPPET_MAX_LINE_LENGTH) {
    return line
  }

  const matchRanges: Array<[number, number]> = []
  for (const regex of regexes) {
    regex.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = regex.exec(line)) !== null) {
      matchRanges.push([match.index, match.index + match[0].length])
      if (match[0].length === 0) {
        regex.lastIndex += 1
      }
    }
  }

  if (matchRanges.length === 0) {
    return `${line.slice(0, SEARCH_SNIPPET_MAX_LINE_LENGTH)}...`
  }

  const expandedRanges: Array<[number, number]> = matchRanges.map(([start, end]) => [
    Math.max(0, start - SEARCH_SNIPPET_LINE_FRAGMENT_RADIUS),
    Math.min(line.length, end + SEARCH_SNIPPET_LINE_FRAGMENT_RADIUS)
  ])
  const mergedRanges = mergeRanges(expandedRanges)
  const limitedRanges = mergedRanges.slice(0, SEARCH_SNIPPET_MAX_LINE_FRAGMENTS)

  let result = limitedRanges.map(([start, end]) => line.slice(start, end)).join(' ... ')
  // 片段未从行首开始，补前置省略号。
  if (limitedRanges[0][0] > 0) {
    result = `...${result}`
  }
  // 片段未覆盖到行尾，补后置省略号。
  if (limitedRanges[limitedRanges.length - 1][1] < line.length) {
    result = `${result}...`
  }
  // 还有未展示的匹配片段，提示省略。
  if (mergedRanges.length > SEARCH_SNIPPET_MAX_LINE_FRAGMENTS) {
    result = `${result}...`
  }
  // 最终长度超限，强制截断并补省略号。
  if (result.length > SEARCH_SNIPPET_MAX_LINE_LENGTH) {
    result = `${result.slice(0, SEARCH_SNIPPET_MAX_LINE_LENGTH)}...`
  }
  return result
}

const buildSearchSnippet = (text: string, terms: string[]) => {
  const normalized = normalizeText(stripMarkdownFormatting(text))
  const lines = normalized.split('\n')
  if (lines.length === 0) {
    return ''
  }

  const nonEmptyTerms = terms.filter((term) => term.length > 0)
  const regexes = nonEmptyTerms.map((term) => new RegExp(escapeRegex(term), 'gi'))
  const matchedLineIndexes: number[] = []

  if (regexes.length > 0) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      const isMatch = regexes.some((regex) => {
        regex.lastIndex = 0
        return regex.test(line)
      })
      if (isMatch) {
        matchedLineIndexes.push(i)
      }
    }
  }

  const ranges: Array<[number, number]> =
    matchedLineIndexes.length > 0
      ? mergeRanges(
          matchedLineIndexes.map((index) => [
            Math.max(0, index - SEARCH_SNIPPET_CONTEXT_LINES),
            Math.min(lines.length - 1, index + SEARCH_SNIPPET_CONTEXT_LINES)
          ])
        )
      : [[0, Math.min(lines.length - 1, SEARCH_SNIPPET_MAX_LINES - 1)]]

  const outputLines: string[] = []
  let truncated = false

  if (ranges[0][0] > 0) {
    outputLines.push('...')
  }

  for (const [start, end] of ranges) {
    if (outputLines.length >= SEARCH_SNIPPET_MAX_LINES) {
      truncated = true
      break
    }
    if (outputLines.length > 0 && outputLines[outputLines.length - 1] !== '...') {
      outputLines.push('...')
    }
    for (let i = start; i <= end; i += 1) {
      if (outputLines.length >= SEARCH_SNIPPET_MAX_LINES) {
        truncated = true
        break
      }
      outputLines.push(buildLineSnippet(lines[i], regexes))
    }
    if (truncated) {
      break
    }
  }

  if ((truncated || ranges[ranges.length - 1][1] < lines.length - 1) && outputLines.at(-1) !== '...') {
    outputLines.push('...')
  }

  return outputLines.join('\n')
}

const isMainTextBlock = (block: MessageBlock): block is Extract<MessageBlock, { type: MessageBlockType.MAIN_TEXT }> =>
  block.type === MessageBlockType.MAIN_TEXT

const resolveTopicForMessage = (
  message: Message,
  storeTopicsMap: Map<string, Topic>,
  t: (key: string) => string
): Topic | undefined => {
  const topicFromStore = storeTopicsMap.get(message.topicId)
  if (topicFromStore) {
    return topicFromStore
  }

  // Hidden thread topics won't exist in the assistant store map.
  if (!isThreadTopicId(message.topicId)) {
    return undefined
  }
  const ref = parseThreadTopicId(message.topicId)
  const parentTopic = ref ? storeTopicsMap.get(ref.parentTopicId) : undefined
  const label = parentTopic ? `${t('thread.title')} · ${parentTopic.name}` : t('thread.title')

  return {
    id: message.topicId,
    assistantId: message.assistantId,
    name: label,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt ?? message.createdAt,
    messages: []
  } satisfies Topic
}

const SORT_OPTIONS: Array<{ label: string; value: HistorySearchSortBy }> = [
  { label: 'Sort: Relevance', value: 'relevance' },
  { label: 'Sort: Newest', value: 'newest' },
  { label: 'Sort: Oldest', value: 'oldest' }
]

const ROLE_OPTIONS: Array<{ label: string; value: HistorySearchRoleFilter }> = [
  { label: 'Role: All', value: 'all' },
  { label: 'Role: User', value: 'user' },
  { label: 'Role: Assistant', value: 'assistant' }
]

const DATE_RANGE_OPTIONS: Array<{ label: string; value: HistorySearchDateRange }> = [
  { label: 'Date: All', value: 'all' },
  { label: 'Date: 24h', value: '24h' },
  { label: 'Date: 7d', value: '7d' },
  { label: 'Date: 30d', value: '30d' }
]

const SearchResults: FC<Props> = ({ keywords, onMessageClick, onTopicClick, ...props }) => {
  const { handleScroll, containerRef } = useScrollPosition('SearchResults')
  const observerRef = useRef<MutationObserver | null>(null)
  const { t } = useTranslation()

  const [searchTerms, setSearchTerms] = useState<string[]>([])
  const [exactPhraseNeedle, setExactPhraseNeedle] = useState('')
  const [sortBy, setSortBy] = useState<HistorySearchSortBy>('relevance')
  const [roleFilter, setRoleFilter] = useState<HistorySearchRoleFilter>('all')
  const [dateRange, setDateRange] = useState<HistorySearchDateRange>('all')
  const [exactPhraseOnly, setExactPhraseOnly] = useState(false)

  const topics = useLiveQuery(() => db.topics.toArray(), [])
  // FIXME: db 中没有 topic.name 等信息，只能从 store 获取
  const storeTopicsMap = useSelector(selectTopicsMap)

  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searchStats, setSearchStats] = useState({ count: 0, time: 0 })
  const [isLoading, setIsLoading] = useState(false)

  const onSearch = useCallback(async () => {
    setSearchResults([])
    setIsLoading(true)

    if (keywords.length === 0) {
      setSearchStats({ count: 0, time: 0 })
      setSearchTerms([])
      setExactPhraseNeedle('')
      setIsLoading(false)
      return
    }

    const startTime = performance.now()
    const allBlocks = await db.message_blocks.toArray()
    const mainTextBlocks = allBlocks.filter(isMainTextBlock)
    const blocksById = new Map(mainTextBlocks.map((block) => [block.id, block]))
    const searchableTextByBlockId = new Map(
      mainTextBlocks.map((block) => [block.id, stripMarkdownFormatting(block.content)])
    )

    const messages = topics?.flatMap((topic) => topic.messages) ?? []
    const messagesById = new Map(messages.map((message) => [message.id, message]))

    const { hits, parsedQuery } = await historySearchEngine.search({
      query: keywords,
      documents: mainTextBlocks.map((block) => ({
        id: block.id,
        content: searchableTextByBlockId.get(block.id) ?? '',
        createdAt: block.createdAt,
        updatedAt: block.updatedAt
      }))
    })

    const derivedNeedle = deriveExactPhraseNeedle(parsedQuery.normalized, parsedQuery.phrases, parsedQuery.terms)
    const highlightTargets = Array.from(
      new Set([
        ...getHighlightTargets(parsedQuery),
        ...(derivedNeedle.length > 0 && derivedNeedle.includes(' ') ? [derivedNeedle] : [])
      ])
    )

    const results = hits
      .map((hit) => {
        const block = blocksById.get(hit.documentId)
        if (!block) {
          return null
        }

        const message = messagesById.get(block.messageId)
        if (!message) {
          return null
        }

        const topic = resolveTopicForMessage(message, storeTopicsMap, t)
        if (!topic) {
          return null
        }
        const searchableText = searchableTextByBlockId.get(block.id) ?? ''

        return {
          message,
          topic,
          content: block.content,
          snippet: buildSearchSnippet(block.content, highlightTargets),
          score: hit.score,
          role: message.role,
          createdAtMs: new Date(message.createdAt).getTime(),
          searchableContent: normalizeSearchString(searchableText)
        }
      })
      .filter((result): result is SearchResult => result !== null)

    const endTime = performance.now()
    setSearchResults(results)
    setSearchStats({
      count: results.length,
      time: (endTime - startTime) / 1000
    })
    setSearchTerms(highlightTargets)
    setExactPhraseNeedle(derivedNeedle)
    setIsLoading(false)
  }, [keywords, storeTopicsMap, t, topics])

  const visibleResults = useMemo(
    () =>
      applyHistorySearchPostProcessing(searchResults, {
        sortBy,
        roleFilter,
        dateRange,
        exactPhraseOnly,
        exactPhraseNeedle: normalizeSearchString(exactPhraseNeedle)
      }),
    [dateRange, exactPhraseNeedle, exactPhraseOnly, roleFilter, searchResults, sortBy]
  )

  const highlightCandidates = useMemo(
    () =>
      Array.from(
        new Set([
          ...searchTerms,
          ...(exactPhraseOnly && exactPhraseNeedle.length > 0 ? [normalizeSearchString(exactPhraseNeedle)] : [])
        ])
      ),
    [exactPhraseNeedle, exactPhraseOnly, searchTerms]
  )

  const highlightText = (text: string) => {
    const uniqueTerms = highlightCandidates.filter((term) => term.length > 0)
    if (uniqueTerms.length === 0) {
      return <span dangerouslySetInnerHTML={{ __html: text }} />
    }

    const pattern = uniqueTerms
      .sort((a, b) => b.length - a.length)
      .map((term) => escapeRegex(term))
      .join('|')
    const regex = new RegExp(pattern, 'gi')
    const highlightedText = text.replace(regex, (match) => `<mark>${match}</mark>`)
    return <span dangerouslySetInnerHTML={{ __html: highlightedText }} />
  }

  useEffect(() => {
    onSearch()
  }, [onSearch])

  useEffect(() => {
    if (!containerRef.current) return

    observerRef.current = new MutationObserver(() => {
      containerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    })

    observerRef.current.observe(containerRef.current, {
      childList: true,
      subtree: true
    })

    return () => observerRef.current?.disconnect()
  }, [containerRef])

  return (
    <Container ref={containerRef} {...props} onScroll={handleScroll}>
      <Spin spinning={isLoading} indicator={<LoadingIcon color="var(--color-text-2)" />}>
        <FilterRow>
          <Select
            size="small"
            value={sortBy}
            onChange={(value: HistorySearchSortBy) => setSortBy(value)}
            options={SORT_OPTIONS}
            style={{ minWidth: 150 }}
          />
          <Select
            size="small"
            value={roleFilter}
            onChange={(value: HistorySearchRoleFilter) => setRoleFilter(value)}
            options={ROLE_OPTIONS}
            style={{ minWidth: 150 }}
          />
          <Select
            size="small"
            value={dateRange}
            onChange={(value: HistorySearchDateRange) => setDateRange(value)}
            options={DATE_RANGE_OPTIONS}
            style={{ minWidth: 130 }}
          />
          <ExactPhraseToggle>
            <Switch
              size="small"
              checked={exactPhraseOnly}
              onChange={setExactPhraseOnly}
              disabled={!exactPhraseNeedle.length}
            />
            <span>Exact phrase</span>
          </ExactPhraseToggle>
        </FilterRow>
        {searchResults.length > 0 && (
          <SearchStats>
            Showing {visibleResults.length} / {searchStats.count} results in {searchStats.time.toFixed(3)} seconds
          </SearchStats>
        )}
        <List
          itemLayout="vertical"
          dataSource={visibleResults}
          pagination={{
            pageSize: 10,
            hideOnSinglePage: true
          }}
          style={{ opacity: isLoading ? 0 : 1 }}
          renderItem={({ message, topic, snippet }) => (
            <List.Item>
              <Title
                level={5}
                style={{ color: 'var(--color-primary)', cursor: 'pointer' }}
                onClick={() => onTopicClick(topic)}>
                {topic.name}
              </Title>
              <div style={{ cursor: 'pointer' }} onClick={() => onMessageClick(message)}>
                <Text style={{ whiteSpace: 'pre-line' }}>{highlightText(snippet)}</Text>
              </div>
              <SearchResultTime>
                <Text type="secondary">{new Date(message.createdAt).toLocaleString()}</Text>
              </SearchResultTime>
            </List.Item>
          )}
        />
        <div style={{ minHeight: 30 }}></div>
      </Spin>
    </Container>
  )
}

const Container = styled.div`
  width: 100%;
  height: 100%;
  padding: 20px 36px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
`

const SearchStats = styled.div`
  font-size: 13px;
  color: var(--color-text-3);
  margin-top: 8px;
`

const SearchResultTime = styled.div`
  margin-top: 10px;
  text-align: right;
`

const FilterRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
`

const ExactPhraseToggle = styled.label`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--color-text-2);
  font-size: 12px;
`

export default memo(SearchResults)
