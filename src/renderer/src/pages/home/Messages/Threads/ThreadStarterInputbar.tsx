import { loggerService } from '@logger'
import { useInputText } from '@renderer/hooks/useInputText'
import { useTextareaResize } from '@renderer/hooks/useTextareaResize'
import { InputbarCore } from '@renderer/pages/home/Inputbar/components/InputbarCore'
import { InputbarToolsProvider } from '@renderer/pages/home/Inputbar/context/InputbarToolsProvider'
import { CacheService } from '@renderer/services/CacheService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { TopicType } from '@renderer/types'
import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

const logger = loggerService.withContext('ThreadStarterInputbar')

const DRAFT_CACHE_TTL = 24 * 60 * 60 * 1000 // 24 hours (same as main input)

type Props = {
  parentTopicId: string
  parentMessageId: string

  placeholder: string
  focusComposer?: boolean
  draft?: string

  onSend: (content: string) => Promise<void>
}

const ThreadStarterInputbar: FC<Props> = ({
  parentTopicId,
  parentMessageId,
  placeholder,
  focusComposer,
  draft,
  onSend
}) => {
  const { t } = useTranslation()

  // Keep drafts isolated per parent message so navigating between threads doesn't overwrite user input.
  const draftCacheKey = useMemo(
    () => `inputbar-draft:thread-starter:${parentTopicId}:${parentMessageId}`,
    [parentMessageId, parentTopicId]
  )

  const initialState = useMemo(
    () => ({
      files: [],
      mentionedModels: [],
      selectedKnowledgeBases: [],
      isExpanded: false,
      couldAddImageFile: false,
      extensions: []
    }),
    []
  )

  const { text, setText } = useInputText({
    initialValue: CacheService.get<string>(draftCacheKey) ?? '',
    onChange: (value) => CacheService.set(draftCacheKey, value, DRAFT_CACHE_TTL)
  })

  const {
    textareaRef,
    resize: resizeTextArea,
    focus: focusTextarea,
    customHeight,
    setCustomHeight
  } = useTextareaResize({
    maxHeight: 500,
    minHeight: 30
  })

  const focusToEnd = useCallback(() => {
    const ta = textareaRef.current?.resizableTextArea?.textArea
    if (!ta) return
    try {
      ta.focus()
      const len = ta.value?.length ?? 0
      ta.setSelectionRange(len, len)
    } catch {
      // ignore
    }
  }, [textareaRef])

  // Apply initial seeded draft (selection -> typing flow). Don't clobber an existing draft.
  useEffect(() => {
    if (typeof draft !== 'string') return
    setText((prev) => (prev ? prev : draft))
  }, [draft, setText])

  // When opening via selection typing, ensure the caret ends up at the end of the seeded content.
  useEffect(() => {
    if (!focusComposer) return
    requestAnimationFrame(() => focusToEnd())
  }, [focusComposer, focusToEnd])

  // Buffer keystrokes during the focus transition (so the first characters don't get "lost").
  useEffect(() => {
    const unsubscribe = EventEmitter.on(
      EVENT_NAMES.THREAD_STARTER_APPEND_DRAFT,
      (payload: { parentTopicId: string; parentMessageId: string; key: string }) => {
        if (payload.parentTopicId !== parentTopicId) return
        if (payload.parentMessageId !== parentMessageId) return

        setText((prev) => prev + payload.key)
        requestAnimationFrame(() => focusToEnd())
      }
    )
    return () => unsubscribe()
  }, [focusToEnd, parentMessageId, parentTopicId, setText])

  const [isSending, setIsSending] = useState(false)
  const handleSendMessage = useCallback(async () => {
    const content = text.trim()
    if (!content) return
    if (isSending) return

    try {
      setIsSending(true)
      await onSend(content)
      setText('')
      requestAnimationFrame(() => resizeTextArea(true))
    } catch (error) {
      logger.error('Failed to create thread:', error as Error)
      window.toast?.error?.(t('thread.create_failed'))
    } finally {
      setIsSending(false)
    }
  }, [isSending, onSend, resizeTextArea, setText, t, text])

  return (
    <CompactWrapper>
      <InputbarToolsProvider
        initialState={initialState}
        actions={{
          resizeTextArea: () => {},
          addNewTopic: () => {},
          clearTopic: () => {},
          onNewContext: () => {},
          onTextChange: () => {},
          toggleExpanded: () => {}
        }}>
        <InputbarCore
          scope={TopicType.Chat}
          placeholder={placeholder}
          text={text}
          onTextChange={setText}
          textareaRef={textareaRef}
          height={customHeight}
          onHeightChange={setCustomHeight}
          resizeTextArea={resizeTextArea}
          focusTextarea={focusTextarea}
          isLoading={isSending}
          supportedExts={[]}
          handleSendMessage={handleSendMessage}
          leftToolbar={null}
          rightToolbar={null}
          topContent={null}
          autoFocus={Boolean(focusComposer)}
        />
      </InputbarToolsProvider>
    </CompactWrapper>
  )
}

const CompactWrapper = styled.div`
  /* The main inputbar uses generous padding for the chat layout; the sidebar should be tighter. */
  .inputbar {
    padding: 0 0 10px 0;
  }
  [navbar-position='top'] & .inputbar {
    padding: 0 0 10px 0;
  }
`

export default ThreadStarterInputbar
