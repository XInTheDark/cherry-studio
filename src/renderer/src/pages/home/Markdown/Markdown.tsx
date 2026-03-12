import 'katex/dist/katex.min.css'
import 'katex/dist/contrib/copy-tex'
import 'katex/dist/contrib/mhchem'
import 'remark-github-blockquote-alert/alert.css'

import { loggerService } from '@logger'
import ImageViewer from '@renderer/components/ImageViewer'
import MarkdownShadowDOMRenderer from '@renderer/components/MarkdownShadowDOMRenderer'
import { useSettings } from '@renderer/hooks/useSettings'
import { useSmoothStream } from '@renderer/hooks/useSmoothStream'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { findBestAnchorOffsets, wrapThreadHighlightSafely } from '@renderer/services/ThreadService'
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
import React, { type FC, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
const logger = loggerService.withContext('Markdown')

type MarkdownRenderMode = 'normal' | 'noMath' | 'plainText'

interface MarkdownRenderBoundaryProps {
  children: React.ReactNode
  fallback: React.ReactNode
  onError: (error: Error) => void
}

interface MarkdownRenderBoundaryState {
  hasError: boolean
}

class MarkdownRenderBoundary extends React.Component<MarkdownRenderBoundaryProps, MarkdownRenderBoundaryState> {
  state: MarkdownRenderBoundaryState = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error: Error) {
    this.props.onError(error)
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback
    }

    return this.props.children
  }
}

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

interface MarkdownRendererProps {
  components: Partial<Components>
  messageContent: string
  rehypePlugins: Pluggable[]
  remarkPlugins: Pluggable[]
  t: (key: string) => string
  urlTransform: (value: string) => string
}

const PlainTextFallback: FC<{ content: string }> = ({ content }) => (
  <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{content}</div>
)

const MarkdownRenderer: FC<MarkdownRendererProps> = ({
  components,
  messageContent,
  rehypePlugins,
  remarkPlugins,
  t,
  urlTransform
}) => (
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
)

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
  const didInitRenderModeRef = useRef(false)
  const mathEnabled = mathEngine !== 'none'
  const [renderMode, setRenderMode] = useState<MarkdownRenderMode>(mathEnabled ? 'normal' : 'noMath')

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

      try {
        wrapThreadHighlightSafely(root, offsets, {
          threadTopicId: hl.threadTopicId,
          parentMessageId: hl.parentMessageId,
          starterPrompt: hl.starterPrompt
        })
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

  const messageContent = useMemo(() => {
    if ('status' in block && block.status === 'paused' && isEmpty(block.content)) {
      return t('message.chat.completion.paused')
    }
    return removeSvgEmptyLines(processLatexBrackets(displayedContent))
  }, [block, displayedContent, t])

  // Retry math rendering when the block/settings change or when a stream finishes.
  const renderRetryKey = useMemo(
    () =>
      [block.id, mathEngine, mathEnableSingleDollar, isStreamDone ? messageContent : (block.status ?? 'unknown')].join(
        '::'
      ),
    [block.id, mathEnableSingleDollar, mathEngine, isStreamDone, messageContent, block.status]
  )

  useEffect(() => {
    if (!didInitRenderModeRef.current) {
      didInitRenderModeRef.current = true
      return
    }

    setRenderMode(mathEnabled ? 'normal' : 'noMath')
  }, [mathEnabled, renderRetryKey])

  const shouldUseMathPlugins = mathEnabled && renderMode === 'normal'

  const remarkPlugins = useMemo(() => {
    const plugins = [
      [remarkGfm, { singleTilde: false }] as Pluggable,
      [remarkAlert] as Pluggable,
      remarkCjkFriendly,
      remarkDisableConstructs(['codeIndented'])
    ]
    if (shouldUseMathPlugins) {
      plugins.push([remarkMath, { singleDollarTextMath: mathEnableSingleDollar }])
    }
    return plugins
  }, [mathEnableSingleDollar, shouldUseMathPlugins])

  const rehypePlugins = useMemo(() => {
    const plugins: Pluggable[] = []
    if (ALLOWED_ELEMENTS.test(messageContent)) {
      plugins.push(rehypeRaw, rehypeScalableSvg)
    }
    plugins.push([rehypeHeadingIds, { prefix: `heading-${block.id}` }])
    if (shouldUseMathPlugins && mathEngine === 'KaTeX') {
      plugins.push(rehypeKatex)
    } else if (shouldUseMathPlugins && mathEngine === 'MathJax') {
      plugins.push(rehypeMathjax)
    }
    return plugins
  }, [block.id, mathEngine, messageContent, shouldUseMathPlugins])

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

  const handleMarkdownRenderError = useCallback(
    (error: Error) => {
      if (shouldUseMathPlugins) {
        logger.warn('Markdown math rendering failed; retrying without math rendering', {
          blockId: block.id,
          messageId: block.messageId,
          mathEngine,
          error: error.message
        })
        setRenderMode('noMath')
        return
      }

      logger.error('Markdown rendering failed; falling back to plain text', {
        blockId: block.id,
        messageId: block.messageId,
        mathEngine,
        renderMode,
        error: error.message
      })
      setRenderMode('plainText')
    },
    [block.id, block.messageId, mathEngine, renderMode, shouldUseMathPlugins]
  )

  return (
    <div
      className="markdown"
      ref={containerRef}
      onMouseOver={handleMouseOver}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}>
      {renderMode === 'plainText' ? (
        <PlainTextFallback content={messageContent} />
      ) : (
        <MarkdownRenderBoundary
          key={`${renderMode}::${renderRetryKey}`}
          fallback={<PlainTextFallback content={messageContent} />}
          onError={handleMarkdownRenderError}>
          <MarkdownRenderer
            components={components}
            messageContent={messageContent}
            rehypePlugins={rehypePlugins}
            remarkPlugins={remarkPlugins}
            t={t}
            urlTransform={urlTransform}
          />
        </MarkdownRenderBoundary>
      )}
    </div>
  )
}

export default memo(Markdown)
