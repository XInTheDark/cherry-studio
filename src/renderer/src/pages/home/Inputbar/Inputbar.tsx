import { loggerService } from '@logger'
import { UNLIMITED_MAX_CONTEXT_TOKENS } from '@renderer/config/constant'
import {
  isAutoEnableImageGenerationModel,
  isGenerateImageModel,
  isGenerateImageModels,
  isMandatoryWebSearchModel,
  isVisionModel,
  isVisionModels,
  isWebSearchModel
} from '@renderer/config/models'
import db from '@renderer/databases'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useInputText } from '@renderer/hooks/useInputText'
import { useMessageOperations, useTopicLoading, useTopicMessages } from '@renderer/hooks/useMessageOperations'
import { useSettings } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useTextareaResize } from '@renderer/hooks/useTextareaResize'
import { useTimer } from '@renderer/hooks/useTimer'
import {
  InputbarToolsProvider,
  useInputbarToolsDispatch,
  useInputbarToolsInternalDispatch,
  useInputbarToolsState
} from '@renderer/pages/home/Inputbar/context/InputbarToolsProvider'
import { getDefaultTopic } from '@renderer/services/AssistantService'
import { CacheService } from '@renderer/services/CacheService'
import { ConversationCompactionService } from '@renderer/services/ConversationCompactionService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import FileManager from '@renderer/services/FileManager'
import { checkRateLimit, getUserMessage } from '@renderer/services/MessagesService'
import { spanManagerService } from '@renderer/services/SpanManagerService'
import { estimateTextTokens as estimateTxtTokens, estimateUserPromptUsage } from '@renderer/services/TokenService'
import WebSearchService from '@renderer/services/WebSearchService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { sendMessage as _sendMessage } from '@renderer/store/thunk/messageThunk'
import {
  type Assistant,
  type ConversationCompactionState,
  type FileType,
  type KnowledgeBase,
  type Model,
  type Topic,
  TopicType
} from '@renderer/types'
import type { MessageInputBaseParams } from '@renderer/types/newMessage'
import { delay } from '@renderer/utils'
import { getSendMessageShortcutLabel } from '@renderer/utils/input'
import { documentExts, imageExts, textExts } from '@shared/config/constant'
import { debounce } from 'lodash'
import type { FC } from 'react'
import React, { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { InputbarCore } from './components/InputbarCore'
import InputbarTools from './InputbarTools'
import KnowledgeBaseInput from './KnowledgeBaseInput'
import MentionModelsInput from './MentionModelsInput'
import { getInputbarConfig } from './registry'
import SleepKeepAliveIndicator from './SleepKeepAliveIndicator'
import TokenCount from './TokenCount'

const logger = loggerService.withContext('Inputbar')

const INPUTBAR_DRAFT_CACHE_KEY = 'inputbar-draft'
const DRAFT_CACHE_TTL = 24 * 60 * 60 * 1000 // 24 hours

const getMentionedModelsCacheKey = (assistantId: string) => `inputbar-mentioned-models-${assistantId}`

const getValidatedCachedModels = (assistantId: string): Model[] => {
  const cached = CacheService.get<Model[]>(getMentionedModelsCacheKey(assistantId))
  if (!Array.isArray(cached)) return []
  return cached.filter((model) => model?.id && model?.name)
}

interface Props {
  assistant: Assistant
  setActiveTopic: (topic: Topic) => void
  topic: Topic
  // By default, the input draft is stored under a single global key. Thread sidebars
  // render a second input, so allow callers to isolate drafts per thread.
  draftCacheKey?: string
  // Optional UI/behavior overrides for embedded composers (e.g. thread starter).
  placeholder?: string
  autoFocus?: boolean
  onSendText?: (content: string) => Promise<void>
  onSendError?: (error: unknown) => void
  onControllerChange?: (controller: InputbarController | null) => void
}

export type InputbarController = {
  setText: (updater: string | ((prev: string) => string)) => void
  focusToEnd: () => void
}

type ProviderActionHandlers = {
  resizeTextArea: () => void
  addNewTopic: () => void
  clearTopic: () => void
  onNewContext: () => void
  onTextChange: (updater: string | ((prev: string) => string)) => void
  toggleExpanded: (nextState?: boolean) => void
}

type ContextTokenStats = {
  current: number
  max: number
  compaction?: {
    summaryTokens: number
    segments: number
    compactedMessageCount: number
    updatedAt: string
    state: ConversationCompactionState
  }
}

const Inputbar: FC<Props> = ({
  assistant: initialAssistant,
  setActiveTopic,
  topic,
  draftCacheKey,
  placeholder,
  autoFocus,
  onSendText,
  onSendError,
  onControllerChange
}) => {
  const actionsRef = useRef<ProviderActionHandlers>({
    resizeTextArea: () => {},
    addNewTopic: () => {},
    clearTopic: () => {},
    onNewContext: () => {},
    onTextChange: () => {},
    toggleExpanded: () => {}
  })

  const [initialMentionedModels] = useState(() => getValidatedCachedModels(initialAssistant.id))
  const draftKey = draftCacheKey ?? INPUTBAR_DRAFT_CACHE_KEY

  const initialState = useMemo(
    () => ({
      files: [] as FileType[],
      mentionedModels: initialMentionedModels,
      selectedKnowledgeBases: initialAssistant.knowledge_bases ?? [],
      isExpanded: false,
      couldAddImageFile: false,
      extensions: [] as string[]
    }),
    [initialMentionedModels, initialAssistant.knowledge_bases]
  )

  return (
    <InputbarToolsProvider
      initialState={initialState}
      actions={{
        resizeTextArea: () => actionsRef.current.resizeTextArea(),
        addNewTopic: () => actionsRef.current.addNewTopic(),
        clearTopic: () => actionsRef.current.clearTopic(),
        onNewContext: () => actionsRef.current.onNewContext(),
        onTextChange: (updater) => actionsRef.current.onTextChange(updater),
        toggleExpanded: (next) => actionsRef.current.toggleExpanded(next)
      }}>
      <InputbarInner
        assistant={initialAssistant}
        setActiveTopic={setActiveTopic}
        topic={topic}
        actionsRef={actionsRef}
        draftCacheKey={draftKey}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onSendText={onSendText}
        onSendError={onSendError}
        onControllerChange={onControllerChange}
      />
    </InputbarToolsProvider>
  )
}

interface InputbarInnerProps extends Props {
  actionsRef: React.RefObject<ProviderActionHandlers>
  draftCacheKey: string
}

const InputbarInner: FC<InputbarInnerProps> = ({
  assistant: initialAssistant,
  setActiveTopic,
  topic,
  actionsRef,
  draftCacheKey,
  placeholder: customPlaceholder,
  autoFocus = true,
  onSendText,
  onSendError,
  onControllerChange
}) => {
  const scope = topic.type ?? TopicType.Chat
  const config = getInputbarConfig(scope)

  const { files, mentionedModels, selectedKnowledgeBases } = useInputbarToolsState()
  const { setFiles, setMentionedModels, setSelectedKnowledgeBases } = useInputbarToolsDispatch()
  const { setCouldAddImageFile } = useInputbarToolsInternalDispatch()

  const { text, setText } = useInputText({
    initialValue: CacheService.get<string>(draftCacheKey) ?? '',
    onChange: (value) => CacheService.set(draftCacheKey, value, DRAFT_CACHE_TTL)
  })
  const {
    textareaRef,
    resize: resizeTextArea,
    focus: focusTextarea,
    setExpanded,
    isExpanded: textareaIsExpanded,
    customHeight,
    setCustomHeight
  } = useTextareaResize({
    maxHeight: 500,
    minHeight: 30
  })

  const { assistant, addTopic, model, setModel, updateAssistant } = useAssistant(initialAssistant.id)
  const { sendMessageShortcut, showInputEstimatedTokens, enableQuickPanelTriggers, keepChatRequestsAliveOnSleep } =
    useSettings()
  const [isCustomSending, setIsCustomSending] = useState(false)
  const [estimateTokenCount, setEstimateTokenCount] = useState(0)
  const [contextTokens, setContextTokens] = useState<ContextTokenStats>({ current: 0, max: 0 })

  const { t } = useTranslation()
  const { pauseMessages } = useMessageOperations(topic)
  const topicMessages = useTopicMessages(topic.id)
  const loading = useTopicLoading(topic)
  const dispatch = useAppDispatch()
  const isVisionAssistant = useMemo(() => isVisionModel(model), [model])
  const isGenerateImageAssistant = useMemo(() => isGenerateImageModel(model), [model])
  const { setTimeoutTimer } = useTimer()
  const isMultiSelectMode = useAppSelector((state) => state.runtime.chat.isMultiSelectMode)
  const hasActiveChatRequest = useAppSelector((state) =>
    Object.values(state.messages.loadingByTopic ?? {}).some((isLoading) => Boolean(isLoading))
  )
  const showSleepKeepAliveIndicator = keepChatRequestsAliveOnSleep && hasActiveChatRequest

  const isVisionSupported = useMemo(
    () =>
      (mentionedModels.length > 0 && isVisionModels(mentionedModels)) ||
      (mentionedModels.length === 0 && isVisionAssistant),
    [mentionedModels, isVisionAssistant]
  )

  const isGenerateImageSupported = useMemo(
    () =>
      (mentionedModels.length > 0 && isGenerateImageModels(mentionedModels)) ||
      (mentionedModels.length === 0 && isGenerateImageAssistant),
    [mentionedModels, isGenerateImageAssistant]
  )

  const canAddImageFile = useMemo(() => {
    return isVisionSupported || isGenerateImageSupported
  }, [isGenerateImageSupported, isVisionSupported])

  const canAddTextFile = useMemo(() => {
    return isVisionSupported || (!isVisionSupported && !isGenerateImageSupported)
  }, [isGenerateImageSupported, isVisionSupported])

  const supportedExts = useMemo(() => {
    if (canAddImageFile && canAddTextFile) {
      return [...imageExts, ...documentExts, ...textExts]
    }

    if (canAddImageFile) {
      return [...imageExts]
    }

    if (canAddTextFile) {
      return [...documentExts, ...textExts]
    }

    return []
  }, [canAddImageFile, canAddTextFile])

  useEffect(() => {
    setCouldAddImageFile(canAddImageFile)
  }, [canAddImageFile, setCouldAddImageFile])

  const onUnmount = useEffectEvent((id: string) => {
    CacheService.set(getMentionedModelsCacheKey(id), mentionedModels, DRAFT_CACHE_TTL)
  })

  useEffect(() => {
    return () => onUnmount(assistant.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistant.id])

  const placeholderText = customPlaceholder
    ? customPlaceholder
    : enableQuickPanelTriggers
      ? t('chat.input.placeholder', { key: getSendMessageShortcutLabel(sendMessageShortcut) })
      : t('chat.input.placeholder_without_triggers', {
          key: getSendMessageShortcutLabel(sendMessageShortcut),
          defaultValue: t('chat.input.placeholder', {
            key: getSendMessageShortcutLabel(sendMessageShortcut)
          })
        })

  const sendMessage = useCallback(async () => {
    if (onSendText) {
      const content = text.trim()
      if (!content || isCustomSending) {
        return
      }

      try {
        setIsCustomSending(true)
        await onSendText(content)
        setText('')
        setFiles([])
        setTimeoutTimer('sendMessage_custom', () => resizeTextArea(true), 0)
      } catch (error) {
        logger.warn('Failed to send custom inputbar message:', error as Error)
        onSendError?.(error)
      } finally {
        setIsCustomSending(false)
      }

      return
    }

    if (checkRateLimit(assistant)) {
      return
    }

    logger.info('Starting to send message')

    const parent = spanManagerService.startTrace(
      { topicId: topic.id, name: 'sendMessage', inputs: text },
      mentionedModels.length > 0 ? mentionedModels : [assistant.model]
    )
    EventEmitter.emit(EVENT_NAMES.SEND_MESSAGE, { topicId: topic.id, traceId: parent?.spanContext().traceId })

    try {
      const uploadedFiles = await FileManager.uploadFiles(files)

      const baseUserMessage: MessageInputBaseParams = { assistant, topic, content: text }
      if (uploadedFiles) {
        baseUserMessage.files = uploadedFiles
      }
      if (mentionedModels.length) {
        baseUserMessage.mentions = mentionedModels
      }

      baseUserMessage.usage = await estimateUserPromptUsage(baseUserMessage)

      const { message, blocks } = getUserMessage(baseUserMessage)
      message.traceId = parent?.spanContext().traceId

      dispatch(_sendMessage(message, blocks, assistant, topic.id))

      setText('')
      setFiles([])
      setTimeoutTimer('sendMessage_1', () => setText(''), 500)
      setTimeoutTimer('sendMessage_2', () => resizeTextArea(), 0)
    } catch (error) {
      logger.warn('Failed to send message:', error as Error)
      parent?.recordException(error as Error)
    }
  }, [
    onSendText,
    text,
    isCustomSending,
    assistant,
    topic,
    mentionedModels,
    files,
    dispatch,
    setText,
    setFiles,
    setTimeoutTimer,
    resizeTextArea,
    onSendError
  ])

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

  const setTextRef = useRef(setText)
  const focusToEndRef = useRef(focusToEnd)

  useEffect(() => {
    setTextRef.current = setText
  }, [setText])

  useEffect(() => {
    focusToEndRef.current = focusToEnd
  }, [focusToEnd])

  useEffect(() => {
    if (!onControllerChange) return

    onControllerChange({
      setText: (updater) => setTextRef.current(updater),
      focusToEnd: () => focusToEndRef.current()
    })

    return () => onControllerChange(null)
  }, [onControllerChange])

  const handleCompactConversation = useCallback(async () => {
    const result = await ConversationCompactionService.compactConversation({
      topicId: topic.id,
      assistant,
      messages: topicMessages
    })

    if (result.status === 'success') {
      window.toast.success(
        t('chat.input.compaction.compact_success', {
          count: result.compactedMessageCount,
          segments: result.addedSegments
        })
      )
    } else if (result.status === 'noop') {
      const reasonKey =
        result.reason === 'already_compact'
          ? 'chat.input.compaction.already_compact'
          : 'chat.input.compaction.not_enough_messages'
      window.toast.info(t(reasonKey))
    } else {
      window.toast.error(result.message || t('chat.input.compaction.compact_failed'))
    }

    EventEmitter.emit(EVENT_NAMES.REFRESH_CONTEXT_TOKEN_COUNT, { topicId: topic.id })
  }, [assistant, t, topic.id, topicMessages])

  const handleClearCompaction = useCallback(async () => {
    await ConversationCompactionService.clearCompaction(topic.id)
    window.toast.success(t('chat.input.compaction.clear_success'))
    EventEmitter.emit(EVENT_NAMES.REFRESH_CONTEXT_TOKEN_COUNT, { topicId: topic.id })
  }, [t, topic.id])

  const tokenCountProps = useMemo(() => {
    if (!config.showTokenCount || estimateTokenCount === undefined) {
      return undefined
    }

    const maxContextTokens = assistant?.settings?.maxContextTokens ?? UNLIMITED_MAX_CONTEXT_TOKENS
    const hasContextBudget = maxContextTokens < UNLIMITED_MAX_CONTEXT_TOKENS
    const hasCompaction = Boolean(contextTokens?.compaction)
    const shouldShowContextWidget = showInputEstimatedTokens || hasContextBudget || hasCompaction
    if (!shouldShowContextWidget) {
      return undefined
    }

    return {
      estimateTokenCount,
      inputTokenCount: estimateTokenCount,
      contextTokens,
      onCompactConversation: handleCompactConversation,
      onClearCompaction: handleClearCompaction,
      showEstimatedTokens: showInputEstimatedTokens
    }
  }, [
    config.showTokenCount,
    assistant?.settings?.maxContextTokens,
    contextTokens,
    estimateTokenCount,
    handleClearCompaction,
    handleCompactConversation,
    showInputEstimatedTokens
  ])

  const onPause = useCallback(async () => {
    await pauseMessages()
  }, [pauseMessages])

  const clearTopic = useCallback(async () => {
    if (loading) {
      await onPause()
      await delay(1)
    }

    EventEmitter.emit(EVENT_NAMES.CLEAR_MESSAGES, topic)
    focusTextarea()
  }, [focusTextarea, loading, onPause, topic])

  const onNewContext = useCallback(() => {
    if (loading) {
      onPause()
      return
    }
    EventEmitter.emit(EVENT_NAMES.NEW_CONTEXT)
  }, [loading, onPause])

  const addNewTopic = useCallback(async () => {
    const newTopic = getDefaultTopic(assistant.id)

    await db.topics.add({ id: newTopic.id, messages: [] })

    if (assistant.defaultModel) {
      setModel(assistant.defaultModel)
    }

    addTopic(newTopic)
    setActiveTopic(newTopic)

    setTimeoutTimer('addNewTopic', () => EventEmitter.emit(EVENT_NAMES.SHOW_TOPIC_SIDEBAR), 0)
  }, [addTopic, assistant.defaultModel, assistant.id, setActiveTopic, setModel, setTimeoutTimer])

  const handleRemoveModel = useCallback(
    (modelToRemove: Model) => {
      setMentionedModels(mentionedModels.filter((current) => current.id !== modelToRemove.id))
    },
    [mentionedModels, setMentionedModels]
  )

  const handleRemoveKnowledgeBase = useCallback(
    (knowledgeBase: KnowledgeBase) => {
      const nextKnowledgeBases = assistant.knowledge_bases?.filter((kb) => kb.id !== knowledgeBase.id)
      updateAssistant({ ...assistant, knowledge_bases: nextKnowledgeBases })
      setSelectedKnowledgeBases(nextKnowledgeBases ?? [])
    },
    [assistant, setSelectedKnowledgeBases, updateAssistant]
  )

  const handleToggleExpanded = useCallback(
    (nextState?: boolean) => {
      const target = typeof nextState === 'boolean' ? nextState : !textareaIsExpanded
      setExpanded(target)
      focusTextarea()
    },
    [focusTextarea, setExpanded, textareaIsExpanded]
  )

  useEffect(() => {
    actionsRef.current = {
      resizeTextArea,
      addNewTopic,
      clearTopic,
      onNewContext,
      onTextChange: setText,
      toggleExpanded: handleToggleExpanded
    }
  }, [resizeTextArea, addNewTopic, clearTopic, onNewContext, setText, handleToggleExpanded, actionsRef])

  useShortcut(
    'new_topic',
    () => {
      addNewTopic()
      EventEmitter.emit(EVENT_NAMES.SHOW_TOPIC_SIDEBAR)
      focusTextarea()
    },
    { preventDefault: true, enableOnFormTags: true, enabled: !onSendText }
  )

  useShortcut('clear_topic', clearTopic, {
    preventDefault: true,
    enableOnFormTags: true,
    enabled: !onSendText
  })

  useEffect(() => {
    if (onSendText) {
      return
    }

    const _setEstimateTokenCount = debounce(setEstimateTokenCount, 100, { leading: false, trailing: true })
    const unsubscribes = [
      EventEmitter.on(EVENT_NAMES.ESTIMATED_TOKEN_COUNT, ({ tokensCount, contextTokens }) => {
        _setEstimateTokenCount(tokensCount)
        setContextTokens(contextTokens)
      }),
      ...[EventEmitter.on(EVENT_NAMES.ADD_NEW_TOPIC, addNewTopic)]
    ]

    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe())
    }
  }, [addNewTopic, onSendText])

  useEffect(() => {
    const debouncedEstimate = debounce((value: string) => {
      if (showInputEstimatedTokens) {
        const count = estimateTxtTokens(value) || 0
        setEstimateTokenCount(count)
      }
    }, 500)

    debouncedEstimate(text)
    return () => debouncedEstimate.cancel()
  }, [showInputEstimatedTokens, text])

  useEffect(() => {
    if (!autoFocus) {
      return
    }

    if (!document.querySelector('.topview-fullscreen-container')) {
      focusTextarea()
    }
  }, [
    autoFocus,
    topic.id,
    assistant.mcpServers,
    assistant.knowledge_bases,
    assistant.enableWebSearch,
    assistant.webSearchProviderId,
    mentionedModels,
    focusTextarea
  ])

  // TODO: Just use assistant.knowledge_bases as selectedKnowledgeBases. context state is overdesigned.
  useEffect(() => {
    setSelectedKnowledgeBases(assistant.knowledge_bases ?? [])
  }, [assistant.knowledge_bases, setSelectedKnowledgeBases])

  useEffect(() => {
    // Disable web search if model doesn't support it
    if (!isWebSearchModel(model) && assistant.enableWebSearch) {
      updateAssistant({ ...assistant, enableWebSearch: false })
    }

    // Clear web search provider if disabled or model has mandatory search
    if (
      assistant.webSearchProviderId &&
      (!WebSearchService.isWebSearchEnabled(assistant.webSearchProviderId) || isMandatoryWebSearchModel(model))
    ) {
      updateAssistant({ ...assistant, webSearchProviderId: undefined })
    }

    // Auto-enable/disable image generation based on model capabilities
    if (isGenerateImageModel(model)) {
      if (isAutoEnableImageGenerationModel(model) && !assistant.enableGenerateImage) {
        updateAssistant({ ...assistant, enableGenerateImage: true })
      }
    } else if (assistant.enableGenerateImage) {
      updateAssistant({ ...assistant, enableGenerateImage: false })
    }
  }, [assistant, model, updateAssistant])

  if (isMultiSelectMode) {
    return null
  }

  // topContent: 所有顶部预览内容
  const topContent = (
    <>
      {selectedKnowledgeBases.length > 0 && (
        <KnowledgeBaseInput
          selectedKnowledgeBases={selectedKnowledgeBases}
          onRemoveKnowledgeBase={handleRemoveKnowledgeBase}
        />
      )}

      {mentionedModels.length > 0 && (
        <MentionModelsInput selectedModels={mentionedModels} onRemoveModel={handleRemoveModel} />
      )}
    </>
  )

  // leftToolbar: 左侧工具栏
  const leftToolbar = config.showTools ? <InputbarTools scope={scope} assistantId={assistant.id} /> : null

  // rightToolbar: 右侧工具栏
  const rightToolbar = (
    <>
      {showSleepKeepAliveIndicator && <SleepKeepAliveIndicator />}
      {tokenCountProps && (
        <TokenCount
          estimateTokenCount={tokenCountProps.estimateTokenCount}
          inputTokenCount={tokenCountProps.inputTokenCount}
          contextTokens={tokenCountProps.contextTokens}
          onCompactConversation={tokenCountProps.onCompactConversation}
          onClearCompaction={tokenCountProps.onClearCompaction}
          showEstimatedTokens={tokenCountProps.showEstimatedTokens}
        />
      )}
    </>
  )

  return (
    <InputbarCore
      scope={scope}
      placeholder={placeholderText}
      autoFocus={autoFocus}
      text={text}
      onTextChange={setText}
      textareaRef={textareaRef}
      height={customHeight}
      onHeightChange={setCustomHeight}
      resizeTextArea={resizeTextArea}
      focusTextarea={focusTextarea}
      isLoading={onSendText ? isCustomSending : loading}
      supportedExts={supportedExts}
      onPause={onSendText ? undefined : onPause}
      handleSendMessage={sendMessage}
      leftToolbar={leftToolbar}
      rightToolbar={rightToolbar}
      topContent={topContent}
      requireTextToSend={Boolean(onSendText)}
    />
  )
}

export default Inputbar
