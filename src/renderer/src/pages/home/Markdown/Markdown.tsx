import 'katex/dist/katex.min.css'
import 'katex/dist/contrib/copy-tex'
import 'katex/dist/contrib/mhchem'
import 'remark-github-blockquote-alert/alert.css'

import ImageViewer from '@renderer/components/ImageViewer'
import MarkdownShadowDOMRenderer from '@renderer/components/MarkdownShadowDOMRenderer'
import { useSettings } from '@renderer/hooks/useSettings'
import { useSmoothStream } from '@renderer/hooks/useSmoothStream'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { findBestAnchorOffsets, rangeFromOffsets } from '@renderer/services/ThreadService'
import type {
  CompactMessageBlock,
  MainTextMessageBlock,
  ThinkingMessageBlock,
  TranslationMessageBlock
} from '@renderer/types/newMessage'
import type { ThreadAnchor } from '@renderer/types/thread'
import { removeSvgEmptyLines } from '@renderer/utils/formats'
import { processLatexBrackets } from '@renderer/utils/markdown'
import { isEmpty } from 'lodash'
import { type FC, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown, { type Components, defaultUrlTransform } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
// @ts-ignore rehype-mathjax is not typed
import rehypeMathjax from 'rehype-mathjax'
import rehypeRaw from 'rehype-raw'
import remarkCjkFriendly from 'remark-cjk-friendly'
import remarkGfm from 'remark-gfm'
import remarkAlert from 'remark-github-blockquote-alert'
import remarkMath from 'remark-math'
import type { Pluggable } from 'unified'

import CodeBlock from './CodeBlock'
import Link from './Link'
import MarkdownSvgRenderer from './MarkdownSvgRenderer'
import rehypeHeadingIds from './plugins/rehypeHeadingIds'
import rehypeScalableSvg from './plugins/rehypeScalableSvg'
import remarkDisableConstructs from './plugins/remarkDisableConstructs'
import Table from './Table'

const ALLOWED_ELEMENTS =
  /<(style|p|div|span|b|i|strong|em|ul|ol|li|table|tr|td|th|thead|tbody|h[1-6]|blockquote|pre|code|br|hr|svg|path|circle|rect|line|polyline|polygon|text|g|defs|title|desc|tspan|sub|sup|details|summary)/i
const DISALLOWED_ELEMENTS = ['iframe', 'script']

interface Props {
  // message: Message & { content: string }
  block: MainTextMessageBlock | TranslationMessageBlock | ThinkingMessageBlock | CompactMessageBlock
  // 可选的后处理函数，用于在流式渲染过程中处理文本（如引用标签转换）
  postProcess?: (text: string) => string
  threadHighlights?: Array<{
    parentMessageId: string
    threadTopicId: string
    starterPrompt: string
    anchor: ThreadAnchor
  }>
}

const Markdown: FC<Props> = ({ block, postProcess, threadHighlights }) => {
  const { t } = useTranslation()
  const { mathEngine, mathEnableSingleDollar } = useSettings()

  const isTrulyDone = 'status' in block && block.status === 'success'
  const [displayedContent, setDisplayedContent] = useState(postProcess ? postProcess(block.content) : block.content)
  const [isStreamDone, setIsStreamDone] = useState(isTrulyDone)

  const prevContentRef = useRef(block.content)
  const prevBlockIdRef = useRef(block.id)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const lastHoverElRef = useRef<HTMLElement | null>(null)

  const { addChunk, reset } = useSmoothStream({
    onUpdate: (rawText) => {
      // 如果提供了后处理函数就调用，否则直接使用原始文本
      const finalText = postProcess ? postProcess(rawText) : rawText
      setDisplayedContent(finalText)
    },
    streamDone: isStreamDone,
    initialText: block.content
  })

  useEffect(() => {
    const newContent = block.content || ''
    const oldContent = prevContentRef.current || ''

    const isDifferentBlock = block.id !== prevBlockIdRef.current

    const isContentReset = oldContent && newContent && !newContent.startsWith(oldContent)

    if (isDifferentBlock || isContentReset) {
      reset(newContent)
    } else {
      const delta = newContent.substring(oldContent.length)
      if (delta) {
        addChunk(delta)
      }
    }

    prevContentRef.current = newContent
    prevBlockIdRef.current = block.id

    // 更新 stream 状态
    const isStreaming = block.status === 'streaming'
    setIsStreamDone(!isStreaming)
  }, [block.content, block.id, block.status, addChunk, reset])

  // Apply (and keep updating) thread highlights as the markdown content streams/changes.
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    if (!threadHighlights || threadHighlights.length === 0) {
      // Clear any previously inserted highlights.
      const existing = root.querySelectorAll<HTMLElement>('[data-thread-highlight="1"]')
      existing.forEach((el) => {
        const parent = el.parentNode
        if (!parent) return
        while (el.firstChild) parent.insertBefore(el.firstChild, el)
        parent.removeChild(el)
      })
      return
    }

    // Remove old highlights before re-applying (keeps offsets stable and avoids nested spans).
    const existing = root.querySelectorAll<HTMLElement>('[data-thread-highlight="1"]')
    existing.forEach((el) => {
      const parent = el.parentNode
      if (!parent) return
      while (el.firstChild) parent.insertBefore(el.firstChild, el)
      parent.removeChild(el)
    })

    const text = root.textContent ?? ''
    for (const hl of threadHighlights) {
      const offsets = findBestAnchorOffsets(text, hl.anchor)
      if (!offsets) continue
      const range = rangeFromOffsets(root, offsets.start, offsets.end)
      if (!range) continue

      try {
        const span = document.createElement('span')
        span.className = 'thread-highlight'
        span.dataset.threadHighlight = '1'
        span.dataset.threadTopicId = hl.threadTopicId
        span.dataset.threadParentMessageId = hl.parentMessageId
        span.dataset.threadStarterPrompt = hl.starterPrompt

        const contents = range.extractContents()
        span.appendChild(contents)
        range.insertNode(span)
      } catch {
        // Some ranges can't be wrapped safely; ignore.
      }
    }
  }, [threadHighlights, displayedContent])

  const handleMouseOver = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement | null
    if (!target) return
    const el = target.closest<HTMLElement>('[data-thread-highlight="1"]')
    if (!el) {
      if (lastHoverElRef.current) {
        lastHoverElRef.current = null
        EventEmitter.emit(EVENT_NAMES.THREAD_HIGHLIGHT_LEAVE)
      }
      return
    }

    if (lastHoverElRef.current === el) return
    lastHoverElRef.current = el

    const prompt = el.dataset.threadStarterPrompt ?? ''
    const rect = el.getBoundingClientRect()
    EventEmitter.emit(EVENT_NAMES.THREAD_HIGHLIGHT_HOVER, { prompt, rect })
  }, [])

  const handleMouseLeave = useCallback(() => {
    lastHoverElRef.current = null
    EventEmitter.emit(EVENT_NAMES.THREAD_HIGHLIGHT_LEAVE)
  }, [])

  const handleClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement | null
    if (!target) return
    const el = target.closest<HTMLElement>('[data-thread-highlight="1"]')
    if (!el) return

    const parentMessageId = el.dataset.threadParentMessageId
    const threadTopicId = el.dataset.threadTopicId
    if (!parentMessageId || !threadTopicId) return

    e.preventDefault()
    e.stopPropagation()
    EventEmitter.emit(EVENT_NAMES.OPEN_THREAD_PANEL, { parentMessageId, threadTopicId })
  }, [])

  const remarkPlugins = useMemo(() => {
    const plugins = [
      [remarkGfm, { singleTilde: false }] as Pluggable,
      [remarkAlert] as Pluggable,
      remarkCjkFriendly,
      remarkDisableConstructs(['codeIndented'])
    ]
    if (mathEngine !== 'none') {
      plugins.push([remarkMath, { singleDollarTextMath: mathEnableSingleDollar }])
    }
    return plugins
  }, [mathEngine, mathEnableSingleDollar])

  const messageContent = useMemo(() => {
    if ('status' in block && block.status === 'paused' && isEmpty(block.content)) {
      return t('message.chat.completion.paused')
    }
    return removeSvgEmptyLines(processLatexBrackets(displayedContent))
  }, [block, displayedContent, t])

  const rehypePlugins = useMemo(() => {
    const plugins: Pluggable[] = []
    if (ALLOWED_ELEMENTS.test(messageContent)) {
      plugins.push(rehypeRaw, rehypeScalableSvg)
    }
    plugins.push([rehypeHeadingIds, { prefix: `heading-${block.id}` }])
    if (mathEngine === 'KaTeX') {
      plugins.push(rehypeKatex)
    } else if (mathEngine === 'MathJax') {
      plugins.push(rehypeMathjax)
    }
    return plugins
  }, [mathEngine, messageContent, block.id])

  const components = useMemo(() => {
    return {
      a: (props: any) => <Link {...props} />,
      code: (props: any) => <CodeBlock {...props} blockId={block.id} />,
      table: (props: any) => <Table {...props} blockId={block.id} />,
      img: (props: any) => <ImageViewer style={{ maxWidth: 500, maxHeight: 500 }} {...props} />,
      pre: (props: any) => <pre style={{ overflow: 'visible' }} {...props} />,
      p: (props) => {
        const hasImage = props?.node?.children?.some((child: any) => child.tagName === 'img')
        if (hasImage) return <div {...props} />
        return <p {...props} />
      },
      svg: MarkdownSvgRenderer
    } as Partial<Components>
  }, [block.id])

  if (/<style\b[^>]*>/i.test(messageContent)) {
    components.style = MarkdownShadowDOMRenderer as any
  }

  const urlTransform = useCallback((value: string) => {
    if (value.startsWith('data:image/png') || value.startsWith('data:image/jpeg')) return value
    return defaultUrlTransform(value)
  }, [])

  return (
    <div
      className="markdown"
      ref={containerRef}
      onMouseOver={handleMouseOver}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}>
      <ReactMarkdown
        rehypePlugins={rehypePlugins}
        remarkPlugins={remarkPlugins}
        components={components}
        disallowedElements={DISALLOWED_ELEMENTS}
        urlTransform={urlTransform}
        remarkRehypeOptions={{
          footnoteLabel: t('common.footnotes'),
          footnoteLabelTagName: 'h4',
          footnoteBackContent: ' '
        }}>
        {messageContent}
      </ReactMarkdown>
    </div>
  )
}

export default memo(Markdown)
