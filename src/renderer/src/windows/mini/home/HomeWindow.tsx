import { loggerService } from '@logger'
import { ActionIconButton } from '@renderer/components/Buttons'
import { isMac } from '@renderer/config/constant'
import { isGenerateImageModel, isVisionModel } from '@renderer/config/models'
import { useTheme } from '@renderer/context/ThemeProvider'
import db from '@renderer/databases'
import { useAssistant, useDefaultAssistant, useDefaultModel } from '@renderer/hooks/useAssistant'
import { useSettings } from '@renderer/hooks/useSettings'
import { useTextareaResize } from '@renderer/hooks/useTextareaResize'
import i18n from '@renderer/i18n'
import { InputbarCore } from '@renderer/pages/home/Inputbar/components/InputbarCore'
import {
  InputbarToolsProvider,
  useInputbarToolsDispatch,
  useInputbarToolsInternalDispatch,
  useInputbarToolsState
} from '@renderer/pages/home/Inputbar/context/InputbarToolsProvider'
import InputbarTools from '@renderer/pages/home/Inputbar/InputbarTools'
import KnowledgeBaseInput from '@renderer/pages/home/Inputbar/KnowledgeBaseInput'
import MentionModelsInput from '@renderer/pages/home/Inputbar/MentionModelsInput'
import type { InputbarScope } from '@renderer/pages/home/Inputbar/types'
import { fetchChatCompletion } from '@renderer/services/ApiService'
import { getDefaultTopic } from '@renderer/services/AssistantService'
import { ConversationService } from '@renderer/services/ConversationService'
import FileManager from '@renderer/services/FileManager'
import { deleteMessageFiles, getAssistantMessage, getUserMessage } from '@renderer/services/MessagesService'
import store, { useAppSelector } from '@renderer/store'
import { addTopic } from '@renderer/store/assistants'
import { updateOneBlock, upsertManyBlocks, upsertOneBlock } from '@renderer/store/messageBlock'
import { newMessagesActions, selectMessagesForTopic } from '@renderer/store/newMessage'
import type { QuickAssistantCommand } from '@renderer/store/settings'
import {
  cancelThrottledBlockUpdate,
  cloneMessagesToNewTopicThunk,
  throttledBlockUpdate,
  updateFileCount
} from '@renderer/store/thunk/messageThunk'
import type { FileType, Topic } from '@renderer/types'
import { ThemeMode } from '@renderer/types'
import type { Chunk } from '@renderer/types/chunk'
import { ChunkType } from '@renderer/types/chunk'
import { AssistantMessageStatus, MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { abortCompletion } from '@renderer/utils/abortController'
import { isAbortError } from '@renderer/utils/error'
import { createMainTextBlock, createThinkingBlock } from '@renderer/utils/messageUtils/create'
import { replacePromptVariables } from '@renderer/utils/prompt'
import { defaultLanguage, documentExts, imageExts, textExts } from '@shared/config/constant'
import { IpcChannel } from '@shared/IpcChannel'
import { Divider, Tooltip } from 'antd'
import { cloneDeep } from 'lodash'
import { ExternalLink, Pin, PinOff, PlusSquare, X } from 'lucide-react'
import type { FC } from 'react'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import ChatWindow from '../chat/ChatWindow'
import type { FeatureMenusRef } from './components/FeatureMenus'
import FeatureMenus from './components/FeatureMenus'

const logger = loggerService.withContext('MiniHomeWindow')

const INPUT_SCOPE: InputbarScope = 'mini-window'

type ProviderActionHandlers = {
  resizeTextArea: () => void
  addNewTopic: () => void
  clearTopic: () => void
  onNewContext: () => void
  onTextChange: (updater: string | ((prev: string) => string)) => void
  toggleExpanded: (nextState?: boolean) => void
}

const HomeWindow: FC<{ draggable?: boolean }> = ({ draggable = true }) => {
  const actionsRef = useRef<ProviderActionHandlers>({
    resizeTextArea: () => {},
    addNewTopic: () => {},
    clearTopic: () => {},
    onNewContext: () => {},
    onTextChange: () => {},
    toggleExpanded: () => {}
  })

  return (
    <InputbarToolsProvider
      initialState={{
        files: [],
        mentionedModels: [],
        selectedKnowledgeBases: [],
        isExpanded: false,
        couldAddImageFile: false,
        extensions: []
      }}
      actions={{
        resizeTextArea: () => actionsRef.current.resizeTextArea(),
        addNewTopic: () => actionsRef.current.addNewTopic(),
        clearTopic: () => actionsRef.current.clearTopic(),
        onNewContext: () => actionsRef.current.onNewContext(),
        onTextChange: (updater) => actionsRef.current.onTextChange(updater),
        toggleExpanded: (next) => actionsRef.current.toggleExpanded(next)
      }}>
      <HomeWindowInner draggable={draggable} actionsRef={actionsRef} />
    </InputbarToolsProvider>
  )
}

const HomeWindowInner: FC<{ draggable: boolean; actionsRef: React.RefObject<ProviderActionHandlers> }> = ({
  draggable,
  actionsRef
}) => {
  const { language, readClipboardAtStartup, targetLanguage, windowStyle } = useSettings()
  const { theme } = useTheme()
  const { t } = useTranslation()

  const { files, mentionedModels, selectedKnowledgeBases, isExpanded, couldAddImageFile } = useInputbarToolsState()
  const { setFiles, setMentionedModels, setSelectedKnowledgeBases, setIsExpanded } = useInputbarToolsDispatch()
  const { setCouldAddImageFile } = useInputbarToolsInternalDispatch()

  const [text, setText] = useState('')

  const [clipboardText, setClipboardText] = useState('')
  const lastClipboardTextRef = useRef<string | null>(null)

  const [isPinned, setIsPinned] = useState(false)
  const [hideFirstUserMessage, setHideFirstUserMessage] = useState(false)

  const [isLoading, setIsLoading] = useState(false)
  const [isOutputted, setIsOutputted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { quickAssistantId } = useAppSelector((state) => state.llm)
  const { defaultAssistant } = useDefaultAssistant()
  const { quickModel } = useDefaultModel()

  const assistantId = quickAssistantId || defaultAssistant.id
  const { assistant: baseAssistant } = useAssistant(assistantId)

  // When quickAssistantId is empty, Quick Assistant is configured to "use model" (quickModel) instead of an assistant.
  // We still need an assistant-like object for prompt/settings; we reuse the default assistant and override its model.
  const currentAssistant = useMemo(() => {
    if (quickAssistantId) return baseAssistant
    return { ...baseAssistant, model: quickModel, defaultModel: quickModel }
  }, [baseAssistant, quickAssistantId, quickModel])

  const [topic, setTopic] = useState<Topic>(() => getDefaultTopic(currentAssistant.id))
  const currentAskId = useRef('')

  const featureMenusRef = useRef<FeatureMenusRef>(null)
  const [commandsFocused, setCommandsFocused] = useState(false)

  const {
    textareaRef,
    resize: resizeTextArea,
    focus: focusTextarea,
    setExpanded,
    customHeight,
    setCustomHeight
  } = useTextareaResize({
    maxHeight: 280,
    minHeight: 30
  })

  const readClipboard = useCallback(async () => {
    if (!readClipboardAtStartup || !document.hasFocus()) return

    try {
      const next = (await navigator.clipboard.readText())?.trim()
      if (next && next !== lastClipboardTextRef.current) {
        lastClipboardTextRef.current = next
        setClipboardText(next)
      }
    } catch (error) {
      // Clipboard reads can fail in some environments; keep this best-effort.
      logger.warn('Failed to read clipboard:', error as Error)
    }
  }, [readClipboardAtStartup])

  const resetConversation = useCallback(() => {
    if (!topic) return

    // Clean up any uploaded attachments tied to this ephemeral mini-window thread.
    // This keeps file storage and db.files reference counts from leaking.
    const messages = selectMessagesForTopic(store.getState(), topic.id)
    messages.forEach((m) => deleteMessageFiles(m))
    store.dispatch(newMessagesActions.clearTopicMessages(topic.id))

    setTopic(getDefaultTopic(currentAssistant.id))
    setHideFirstUserMessage(false)
    setError(null)
    setIsLoading(false)
    setIsOutputted(false)
    currentAskId.current = ''

    setText('')
    setFiles([])

    // Keep clipboard text (it can still be useful as context for the first command/message).
    setCommandsFocused(false)
  }, [currentAssistant.id, setFiles, topic])

  const handlePause = useCallback(() => {
    if (currentAskId.current) {
      abortCompletion(currentAskId.current)
      setIsLoading(false)
      setIsOutputted(true)
      currentAskId.current = ''
    }
  }, [])

  const handleClose = useCallback(() => {
    window.api.miniWindow.hide()
  }, [])

  const handleEsc = useCallback(() => {
    if (isLoading) {
      handlePause()
      return
    }
    handleClose()
  }, [handleClose, handlePause, isLoading])

  const handleError = useCallback((err: unknown) => {
    setIsLoading(false)
    setIsOutputted(true)
    currentAskId.current = ''
    setError(err instanceof Error ? err.message : 'An error occurred')
  }, [])

  const send = useCallback(
    async ({
      prompt,
      contentOverride,
      hideSourceMessage
    }: {
      prompt?: string
      contentOverride?: string
      hideSourceMessage?: boolean
    }) => {
      if (!topic) return

      const topicMessages = selectMessagesForTopic(store.getState(), topic.id)
      const isFirstMessage = topicMessages.length === 0

      const rawInput = (contentOverride ?? text).trim()

      // First message behavior: if clipboard text is present and user typed a question/instruction,
      // prepend the clipboard content so commands can work on it without forcing a paste.
      const mergedFirstMessageContent = (() => {
        if (!isFirstMessage) return rawInput
        // If the caller explicitly provided "context", don't also prepend clipboard text.
        if (contentOverride) return rawInput
        if (!rawInput) return rawInput
        const clip = clipboardText.trim()
        if (!clip) return rawInput
        // Avoid duplicating if user already pasted it.
        if (rawInput.includes(clip)) return rawInput
        return `${clip}\n\n${rawInput}`
      })()

      const finalContent = mergedFirstMessageContent.trim()
      if (!finalContent) {
        return
      }

      if (isFirstMessage && typeof hideSourceMessage === 'boolean') {
        setHideFirstUserMessage(hideSourceMessage)
      }

      try {
        let uploadedFiles: FileType[] | undefined = undefined
        if (files.length > 0) {
          try {
            const filesPath = store.getState().runtime.filesPath
            uploadedFiles = await Promise.all(
              files.map(async (file) => {
                // Screenshots are saved directly into the app file storage. We only need to ensure a DB record exists.
                if (filesPath && file.path?.startsWith(filesPath)) {
                  return await FileManager.addFile(file)
                }
                return await FileManager.uploadFile(file)
              })
            )
          } catch (error) {
            logger.error('Failed to prepare attachments for mini window message:', error as Error)
            window.toast.error(t('chat.input.file_error'))
            return
          }
        }

        const { message: userMessage, blocks } = getUserMessage({
          content: [prompt, finalContent].filter(Boolean).join('\n\n'),
          assistant: currentAssistant,
          topic,
          files: uploadedFiles
        })

        store.dispatch(newMessagesActions.addMessage({ topicId: topic.id, message: userMessage }))
        store.dispatch(upsertManyBlocks(blocks))

        const assistantMessage = getAssistantMessage({ assistant: currentAssistant, topic })
        assistantMessage.askId = userMessage.id
        currentAskId.current = userMessage.id
        store.dispatch(newMessagesActions.addMessage({ topicId: topic.id, message: assistantMessage }))

        // Capture context up to the just-added user message.
        const allMessagesForTopic = selectMessagesForTopic(store.getState(), topic.id)
        const userMessageIndex = allMessagesForTopic.findIndex((m) => m?.id === userMessage.id)
        const messagesForContext = allMessagesForTopic
          .slice(0, userMessageIndex + 1)
          .filter((m) => m && !m.status?.includes('ing'))

        let blockId: string | null = null
        let thinkingBlockId: string | null = null
        let thinkingStartTime: number | null = null

        const resolveThinkingDuration = (duration?: number) => {
          if (typeof duration === 'number' && Number.isFinite(duration)) return duration
          if (thinkingStartTime !== null) return Math.max(0, performance.now() - thinkingStartTime)
          return 0
        }

        setIsLoading(true)
        setIsOutputted(false)
        setError(null)

        setText('')
        setFiles([])

        const newAssistant = cloneDeep(currentAssistant)
        if (!newAssistant.settings) newAssistant.settings = {}
        newAssistant.settings.streamOutput = true
        newAssistant.prompt = await replacePromptVariables(currentAssistant.prompt, currentAssistant?.model.name)

        const { modelMessages, uiMessages } = await ConversationService.prepareMessagesForModel(
          messagesForContext,
          newAssistant
        )

        await fetchChatCompletion({
          messages: modelMessages,
          assistant: newAssistant,
          requestOptions: {},
          topicId: topic.id,
          uiMessages: uiMessages,
          onChunkReceived: (chunk: Chunk) => {
            switch (chunk.type) {
              case ChunkType.THINKING_START: {
                setIsOutputted(true)
                thinkingStartTime = performance.now()
                if (thinkingBlockId) {
                  store.dispatch(
                    updateOneBlock({ id: thinkingBlockId, changes: { status: MessageBlockStatus.STREAMING } })
                  )
                } else {
                  const block = createThinkingBlock(assistantMessage.id, '', { status: MessageBlockStatus.STREAMING })
                  thinkingBlockId = block.id
                  store.dispatch(
                    newMessagesActions.updateMessage({
                      topicId: topic.id,
                      messageId: assistantMessage.id,
                      updates: { blockInstruction: { id: block.id } }
                    })
                  )
                  store.dispatch(upsertOneBlock(block))
                }
                break
              }
              case ChunkType.THINKING_DELTA: {
                setIsOutputted(true)
                if (thinkingBlockId) {
                  if (thinkingStartTime === null) thinkingStartTime = performance.now()
                  const thinkingDuration = resolveThinkingDuration(chunk.thinking_millsec)
                  throttledBlockUpdate(thinkingBlockId, { content: chunk.text, thinking_millsec: thinkingDuration })
                }
                break
              }
              case ChunkType.THINKING_COMPLETE: {
                if (thinkingBlockId) {
                  const thinkingDuration = resolveThinkingDuration(chunk.thinking_millsec)
                  cancelThrottledBlockUpdate(thinkingBlockId)
                  store.dispatch(
                    updateOneBlock({
                      id: thinkingBlockId,
                      changes: { status: MessageBlockStatus.SUCCESS, thinking_millsec: thinkingDuration }
                    })
                  )
                }
                thinkingStartTime = null
                thinkingBlockId = null
                break
              }
              case ChunkType.TEXT_START: {
                setIsOutputted(true)
                if (blockId) {
                  store.dispatch(updateOneBlock({ id: blockId, changes: { status: MessageBlockStatus.STREAMING } }))
                } else {
                  const block = createMainTextBlock(assistantMessage.id, '', { status: MessageBlockStatus.STREAMING })
                  blockId = block.id
                  store.dispatch(
                    newMessagesActions.updateMessage({
                      topicId: topic.id,
                      messageId: assistantMessage.id,
                      updates: { blockInstruction: { id: block.id } }
                    })
                  )
                  store.dispatch(upsertOneBlock(block))
                }
                break
              }
              case ChunkType.TEXT_DELTA: {
                setIsOutputted(true)
                if (blockId) throttledBlockUpdate(blockId, { content: chunk.text })
                break
              }
              case ChunkType.TEXT_COMPLETE: {
                if (blockId) {
                  cancelThrottledBlockUpdate(blockId)
                  store.dispatch(
                    updateOneBlock({
                      id: blockId,
                      changes: { content: chunk.text, status: MessageBlockStatus.SUCCESS }
                    })
                  )
                }
                break
              }
              case ChunkType.ERROR: {
                const isAborted = isAbortError(chunk.error)
                const possibleBlockId = thinkingBlockId || blockId
                if (possibleBlockId) {
                  store.dispatch(
                    updateOneBlock({
                      id: possibleBlockId,
                      changes: { status: isAborted ? MessageBlockStatus.PAUSED : MessageBlockStatus.ERROR }
                    })
                  )
                  store.dispatch(
                    newMessagesActions.updateMessage({
                      topicId: topic.id,
                      messageId: assistantMessage.id,
                      updates: { status: isAborted ? AssistantMessageStatus.PAUSED : AssistantMessageStatus.SUCCESS }
                    })
                  )
                }
                if (!isAborted) {
                  throw new Error(chunk.error.message)
                }
                thinkingStartTime = null
                thinkingBlockId = null
              }
              // fallthrough
              case ChunkType.BLOCK_COMPLETE:
                setIsLoading(false)
                setIsOutputted(true)
                currentAskId.current = ''
                store.dispatch(
                  newMessagesActions.updateMessage({
                    topicId: topic.id,
                    messageId: assistantMessage.id,
                    updates: { status: AssistantMessageStatus.SUCCESS }
                  })
                )
                break
            }
          }
        })
      } catch (err) {
        if (isAbortError(err)) return
        handleError(err)
        logger.error('Mini window send failed:', err as Error)
      } finally {
        setIsLoading(false)
        setIsOutputted(true)
        currentAskId.current = ''
      }
    },
    [clipboardText, currentAssistant, files, handleError, setFiles, text, topic, t]
  )

  const handleSendChat = useCallback(() => {
    void send({})
  }, [send])

  const handleUseCommand = useCallback(
    (command: QuickAssistantCommand) => {
      void (async () => {
        const commandPrompt = (() => {
          if (command.promptKey) {
            if (command.promptKey === 'prompts.translate') {
              return t(command.promptKey, { target_language: targetLanguage })
            }
            return t(command.promptKey)
          }
          if (command.type === 'translate') {
            return t('prompts.translate', { target_language: targetLanguage })
          }
          return command.prompt
        })()

        const shouldUseContext = text.trim().length === 0
        let contentOverride: string | undefined = undefined

        if (shouldUseContext) {
          try {
            // Prefer cached selection captured before the mini window was focused.
            const lastSelected = (await window.api.selection.getLastSelectedText(60_000))?.trim()
            const currentSelected = (await window.api.selection.getCurrentSelectedText())?.trim()
            const selectedText = lastSelected || currentSelected
            if (selectedText) {
              contentOverride = selectedText
            } else if (clipboardText.trim()) {
              contentOverride = clipboardText.trim()
            } else {
              try {
                const clip = (await navigator.clipboard.readText())?.trim()
                if (clip) {
                  lastClipboardTextRef.current = clip
                  setClipboardText(clip)
                  contentOverride = clip
                }
              } catch (error) {
                logger.warn('Failed to read clipboard on demand:', error as Error)
              }
            }
          } catch (error) {
            logger.warn('Failed to resolve selected text context:', error as Error)
          }

          if (!contentOverride) {
            window.toast.info(t('miniwindow.input.no_context'))
            return
          }
        }

        void send({ prompt: commandPrompt, contentOverride, hideSourceMessage: command.hideSourceMessage })
      })()
    },
    [clipboardText, send, t, targetLanguage, text]
  )

  const handleContinueInMainWindow = useCallback(async () => {
    if (isLoading) return

    try {
      const sourceTopicId = topic.id
      const messages = selectMessagesForTopic(store.getState(), sourceTopicId)

      const newTopic = getDefaultTopic(currentAssistant.id)
      await db.topics.add({ id: newTopic.id, messages: [] })
      store.dispatch(addTopic({ assistantId: currentAssistant.id, topic: newTopic }))

      const success = await store.dispatch(cloneMessagesToNewTopicThunk(sourceTopicId, messages.length, newTopic))
      if (!success) {
        window.toast.error(t('common.error'))
        return
      }

      // cloneMessagesToNewTopicThunk increments file counts for the new topic. Since the mini window topic is ephemeral,
      // we neutralize that increment to keep counts consistent.
      const state = store.getState()
      const fileIds = new Set<string>()
      messages.forEach((m) => {
        m.blocks?.forEach((blockId) => {
          const block = state.messageBlocks.entities[blockId]
          if (!block) return
          if (block.type !== MessageBlockType.FILE && block.type !== MessageBlockType.IMAGE) return
          const file = (block as any).file as FileType | undefined
          if (file?.id) fileIds.add(file.id)
        })
      })
      await Promise.all(Array.from(fileIds).map((fileId) => updateFileCount(fileId, -1, false)))

      await window.api.openTopicInMainWindow({ assistantId: currentAssistant.id, topicId: newTopic.id })
      window.api.miniWindow.close()
    } catch (error) {
      logger.error('Failed to continue in main window from mini window:', error as Error)
      window.toast.error(t('common.error'))
    }
  }, [currentAssistant.id, isLoading, t, topic.id])

  // Window show/hide + pin behavior
  useEffect(() => {
    window.api.miniWindow.setPin(isPinned)
  }, [isPinned])

  useEffect(() => {
    i18n.changeLanguage(language || navigator.language || defaultLanguage)
  }, [language])

  useEffect(() => {
    const onWindowShow = async () => {
      await readClipboard()
      focusTextarea()
      featureMenusRef.current?.resetSelectedIndex()
    }

    window.electron.ipcRenderer.on(IpcChannel.ShowMiniWindow, onWindowShow)
    return () => {
      window.electron.ipcRenderer.removeAllListeners(IpcChannel.ShowMiniWindow)
    }
  }, [focusTextarea, readClipboard])

  useEffect(() => {
    readClipboard()
  }, [readClipboard])

  // Determine attachment capabilities from the current assistant model.
  useEffect(() => {
    const model = currentAssistant.model || currentAssistant.defaultModel
    const canAddImage = isVisionModel(model) || isGenerateImageModel(model)
    setCouldAddImageFile(canAddImage)
  }, [currentAssistant, setCouldAddImageFile])

  useEffect(() => {
    // Wire InputbarToolsProvider "parent actions" so tool buttons behave consistently.
    actionsRef.current.resizeTextArea = () => resizeTextArea()
    actionsRef.current.addNewTopic = () => resetConversation()
    actionsRef.current.clearTopic = () => resetConversation()
    actionsRef.current.onNewContext = () => {
      // No-op for mini window for now.
    }
    actionsRef.current.onTextChange = (updater) => {
      setText((prev) => (typeof updater === 'function' ? updater(prev) : updater))
    }
    actionsRef.current.toggleExpanded = (nextState) => {
      const target = typeof nextState === 'boolean' ? nextState : !isExpanded
      setIsExpanded(target)
      setExpanded(target)
      focusTextarea()
    }
  }, [actionsRef, focusTextarea, isExpanded, resetConversation, resizeTextArea, setExpanded, setIsExpanded])

  const supportedExts = useMemo(() => {
    // Mirror the main input behavior: only allow images when the model supports vision/image-generation.
    return couldAddImageFile ? [...imageExts, ...documentExts, ...textExts] : [...documentExts, ...textExts]
  }, [couldAddImageFile])

  const backgroundColor = useMemo(() => {
    if (isMac && windowStyle === 'transparent' && theme === ThemeMode.light) return 'transparent'
    return 'var(--color-background)'
  }, [theme, windowStyle])

  const messages = useAppSelector((state) => selectMessagesForTopic(state, topic.id))
  const hasConversation = messages.length > 0
  const showCommands = !hasConversation

  const handleContainerKeyDownCapture = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.nativeEvent.isComposing) return

      if (e.key === 'Escape') {
        e.preventDefault()
        handleEsc()
        return
      }

      // Cmd+N: start a new conversation (always available).
      if (e.key.toLowerCase() === 'n' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        if (isLoading) return
        resetConversation()
        return
      }

      if (!showCommands) return

      if (e.key === 'Tab') {
        e.preventDefault()
        if (commandsFocused) {
          focusTextarea()
        } else {
          featureMenusRef.current?.focus?.()
        }
      }
    },
    [commandsFocused, focusTextarea, handleEsc, isLoading, resetConversation, showCommands]
  )

  const headerActions = useMemo(() => {
    const items: React.ReactNode[] = []

    if (hasConversation) {
      items.push(
        <Tooltip key="continue" title="Open in main window" mouseEnterDelay={0.6}>
          <ActionIconButton
            className="nodrag"
            onClick={() => void handleContinueInMainWindow()}
            aria-label="Open in main window">
            <ExternalLink size={16} />
          </ActionIconButton>
        </Tooltip>
      )
      items.push(
        <Tooltip key="new" title="New conversation" mouseEnterDelay={0.6}>
          <ActionIconButton className="nodrag" onClick={resetConversation} aria-label="New conversation">
            <PlusSquare size={16} />
          </ActionIconButton>
        </Tooltip>
      )
    }

    items.push(
      <Tooltip key="pin" title={t('miniwindow.tooltip.pin')} mouseEnterDelay={0.6}>
        <ActionIconButton
          className="nodrag"
          onClick={() => setIsPinned((p) => !p)}
          aria-label={t('miniwindow.tooltip.pin')}>
          {isPinned ? <Pin size={16} /> : <PinOff size={16} />}
        </ActionIconButton>
      </Tooltip>
    )

    items.push(
      <Tooltip key="close" title={t('common.close')} mouseEnterDelay={0.6}>
        <ActionIconButton className="nodrag" onClick={handleClose} aria-label={t('common.close')}>
          <X size={16} />
        </ActionIconButton>
      </Tooltip>
    )

    return <HeaderActions className="nodrag">{items}</HeaderActions>
  }, [handleClose, handleContinueInMainWindow, hasConversation, isPinned, resetConversation, t])

  return (
    <Container style={{ backgroundColor }} $draggable={draggable} onKeyDownCapture={handleContainerKeyDownCapture}>
      <Header $draggable={draggable}>
        <HeaderTitle>{t('settings.quickAssistant.title')}</HeaderTitle>
        {headerActions}
      </Header>

      <Content>
        {showCommands ? (
          <CommandsPanel>
            <FeatureMenus
              onUseCommand={handleUseCommand}
              ref={featureMenusRef}
              onFocusChange={setCommandsFocused}
              disabled={isLoading}
            />
          </CommandsPanel>
        ) : (
          <>
            <ChatWindow
              assistant={currentAssistant}
              topic={topic}
              isOutputted={isOutputted}
              hideFirstUserMessage={hideFirstUserMessage}
            />
            {error && <ErrorMsg>{error}</ErrorMsg>}
          </>
        )}
      </Content>

      <Divider style={{ margin: '10px 0' }} />

      <InputArea className="nodrag">
        <InputbarCore
          scope={INPUT_SCOPE}
          placeholder={t('miniwindow.input.placeholder.empty', {
            model: quickAssistantId ? currentAssistant.name : currentAssistant.model.name
          })}
          text={text}
          onTextChange={setText}
          textareaRef={textareaRef}
          resizeTextArea={resizeTextArea}
          focusTextarea={focusTextarea}
          height={customHeight}
          onHeightChange={setCustomHeight}
          supportedExts={supportedExts}
          isLoading={isLoading}
          onPause={handlePause}
          handleSendMessage={handleSendChat}
          leftToolbar={<InputbarTools scope={INPUT_SCOPE} assistantId={currentAssistant.id} />}
          topContent={
            <>
              {selectedKnowledgeBases.length > 0 && (
                <KnowledgeBaseInput
                  selectedKnowledgeBases={selectedKnowledgeBases}
                  onRemoveKnowledgeBase={(knowledgeBase) =>
                    setSelectedKnowledgeBases((prev) => prev.filter((kb) => kb.id !== knowledgeBase.id))
                  }
                />
              )}
              {mentionedModels.length > 0 && (
                <MentionModelsInput
                  selectedModels={mentionedModels}
                  onRemoveModel={(model) =>
                    setMentionedModels((prev) =>
                      prev.filter((m) => !(m.id === model.id && m.provider === model.provider))
                    )
                  }
                />
              )}
            </>
          }
        />
      </InputArea>

      {hasConversation && (
        <FooterHint className="nodrag">
          {t('miniwindow.footer.esc', { action: t('miniwindow.footer.esc_close') })}
        </FooterHint>
      )}
    </Container>
  )
}

const Container = styled.div<{ $draggable: boolean }>`
  display: flex;
  flex: 1;
  height: 100%;
  width: 100%;
  flex-direction: column;
  padding: 8px 10px;
`

const Header = styled.div<{ $draggable: boolean }>`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 4px 8px 4px;
  -webkit-app-region: ${({ $draggable }) => ($draggable ? 'drag' : 'no-drag')};
`

const HeaderTitle = styled.div`
  font-size: 12px;
  color: var(--color-text-2);
  user-select: none;
`

const HeaderActions = styled.div`
  display: flex;
  gap: 6px;
`

const Content = styled.div`
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
`

const CommandsPanel = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  justify-content: center;
  gap: 10px;
`

const InputArea = styled.div`
`

const ErrorMsg = styled.div`
  color: var(--color-error);
  background: rgba(255, 0, 0, 0.15);
  border: 1px solid var(--color-error);
  padding: 8px 12px;
  border-radius: 4px;
  margin-top: 8px;
  font-size: 13px;
  word-break: break-all;
`

const FooterHint = styled.div`
  margin-top: 8px;
  font-size: 11px;
  color: var(--color-text-3);
  user-select: none;
`

export default HomeWindow
