import { loggerService } from '@logger'
import { ActionIconButton } from '@renderer/components/Buttons'
import { isMac } from '@renderer/config/constant'
import { useTheme } from '@renderer/context/ThemeProvider'
import db from '@renderer/databases'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useSettings } from '@renderer/hooks/useSettings'
import i18n from '@renderer/i18n'
import AttachmentPreview from '@renderer/pages/home/Inputbar/AttachmentPreview'
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
import type { FileMetadata, Topic } from '@renderer/types'
import { ThemeMode } from '@renderer/types'
import type { Chunk } from '@renderer/types/chunk'
import { ChunkType } from '@renderer/types/chunk'
import { AssistantMessageStatus, MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { abortCompletion } from '@renderer/utils/abortController'
import { isAbortError } from '@renderer/utils/error'
import { createMainTextBlock, createThinkingBlock } from '@renderer/utils/messageUtils/create'
import { getMainTextContent } from '@renderer/utils/messageUtils/find'
import { replacePromptVariables } from '@renderer/utils/prompt'
import { defaultLanguage } from '@shared/config/constant'
import { IpcChannel } from '@shared/IpcChannel'
import { Divider, Dropdown, Tooltip } from 'antd'
import { cloneDeep, isEmpty } from 'lodash'
import { last } from 'lodash'
import { Monitor, Paperclip } from 'lucide-react'
import type { FC } from 'react'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import ChatWindow from '../chat/ChatWindow'
import TranslateWindow from '../translate/TranslateWindow'
import ClipboardPreview from './components/ClipboardPreview'
import type { FeatureMenusRef } from './components/FeatureMenus'
import FeatureMenus from './components/FeatureMenus'
import Footer from './components/Footer'
import InputBar from './components/InputBar'

const logger = loggerService.withContext('HomeWindow')

const HomeWindow: FC<{ draggable?: boolean }> = ({ draggable = true }) => {
  const { language, readClipboardAtStartup, windowStyle } = useSettings()
  const { theme } = useTheme()
  const { t } = useTranslation()

  const [route, setRoute] = useState<'home' | 'chat' | 'translate' | 'summary' | 'explanation'>('home')
  const [isFirstMessage, setIsFirstMessage] = useState(true)

  const [userInputText, setUserInputText] = useState('')

  const [clipboardText, setClipboardText] = useState('')
  const lastClipboardTextRef = useRef<string | null>(null)

  const [isPinned, setIsPinned] = useState(false)
  const [hideFirstUserMessage, setHideFirstUserMessage] = useState(false)
  const [attachedFiles, setAttachedFiles] = useState<FileMetadata[]>([])

  // Indicator for loading(thinking/streaming)
  const [isLoading, setIsLoading] = useState(false)
  // Indicator for whether the first message is outputted
  const [isOutputted, setIsOutputted] = useState(false)

  const [error, setError] = useState<string | null>(null)

  const { quickAssistantId } = useAppSelector((state) => state.llm)
  const { assistant: currentAssistant } = useAssistant(quickAssistantId)

  const currentTopic = useRef<Topic>(getDefaultTopic(currentAssistant.id))
  const currentAskId = useRef('')

  const inputBarRef = useRef<HTMLDivElement>(null)
  const featureMenusRef = useRef<FeatureMenusRef>(null)

  const referenceText = useMemo(() => clipboardText || userInputText, [clipboardText, userInputText])

  const userContent = useMemo(() => {
    if (isFirstMessage) {
      return referenceText === userInputText ? userInputText : `${referenceText}\n\n${userInputText}`.trim()
    }
    return userInputText.trim()
  }, [isFirstMessage, referenceText, userInputText])

  useEffect(() => {
    i18n.changeLanguage(language || navigator.language || defaultLanguage)
  }, [language])

  // Reset state when switching to home route
  useEffect(() => {
    if (route === 'home') {
      setIsFirstMessage(true)
      setError(null)
      setHideFirstUserMessage(false)
    }
  }, [route])

  const focusInput = useCallback(() => {
    if (inputBarRef.current) {
      const input = inputBarRef.current.querySelector('input')
      if (input) {
        input.focus()
      }
    }
  }, [])

  // Use useCallback with stable dependencies to avoid infinite loops
  const readClipboard = useCallback(async () => {
    if (!readClipboardAtStartup || !document.hasFocus()) return

    try {
      const text = await navigator.clipboard.readText()
      if (text && text !== lastClipboardTextRef.current) {
        lastClipboardTextRef.current = text
        setClipboardText(text.trim())
      }
    } catch (error) {
      // Silently handle clipboard read errors (common in some environments)
      logger.warn('Failed to read clipboard:', error as Error)
    }
  }, [readClipboardAtStartup])

  const clearClipboard = useCallback(async () => {
    setClipboardText('')
    lastClipboardTextRef.current = null
    focusInput()
  }, [focusInput])

  const onWindowShow = useCallback(async () => {
    featureMenusRef.current?.resetSelectedIndex()
    await readClipboard()
    focusInput()
  }, [readClipboard, focusInput])

  useEffect(() => {
    window.api.miniWindow.setPin(isPinned)
  }, [isPinned])

  useEffect(() => {
    window.electron.ipcRenderer.on(IpcChannel.ShowMiniWindow, onWindowShow)

    return () => {
      window.electron.ipcRenderer.removeAllListeners(IpcChannel.ShowMiniWindow)
    }
  }, [onWindowShow])

  useEffect(() => {
    readClipboard()
  }, [readClipboard])

  const handleCloseWindow = useCallback(() => window.api.miniWindow.hide(), [])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // 使用非直接输入法时（例如中文、日文输入法），存在输入法键入过程
    // 键入过程不应有任何响应
    // 例子，中文输入法候选词过程使用`Enter`直接上屏字母，日文输入法候选词过程使用`Enter`输入假名
    // 输入法可以`Esc`终止候选词过程
    // 这两个例子的`Enter`和`Esc`快捷助手都不应该响应
    if (e.nativeEvent.isComposing || e.key === 'Process') {
      return
    }

    switch (e.code) {
      case 'Enter':
      case 'NumpadEnter':
        {
          if (isLoading) return

          e.preventDefault()
          if (userContent) {
            if (route === 'home') {
              featureMenusRef.current?.useFeature()
            } else {
              // Currently text input is only available in 'chat' mode
              setRoute('chat')
              handleSendMessage()
              focusInput()
            }
          }
        }
        break
      case 'Backspace':
        {
          if (userInputText.length === 0) {
            clearClipboard()
          }
        }
        break
      case 'ArrowUp':
        {
          if (route === 'home') {
            e.preventDefault()
            featureMenusRef.current?.prevFeature()
          }
        }
        break
      case 'ArrowDown':
        {
          if (route === 'home') {
            e.preventDefault()
            featureMenusRef.current?.nextFeature()
          }
        }
        break
      case 'Escape':
        {
          handleEsc()
        }
        break
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setUserInputText(e.target.value)
  }

  const handleAttachFiles = useCallback(async () => {
    try {
      const files = await window.api.file.select({
        properties: ['openFile', 'multiSelections']
      })
      if (!files || files.length === 0) return

      setAttachedFiles((prev) => {
        const byPath = new Map<string, FileMetadata>()
        prev.forEach((f) => byPath.set(f.path, f))
        files.forEach((f) => byPath.set(f.path, f))
        return Array.from(byPath.values())
      })
    } catch (error) {
      logger.error('Failed to attach files in mini window:', error as Error)
      window.toast.error(t('chat.input.file_error'))
    }
  }, [t])

  const handleCaptureScreen = useCallback(async () => {
    // Capture the primary screen without the mini window overlay by hiding it briefly.
    try {
      await window.api.miniWindow.hide()
      await new Promise((resolve) => setTimeout(resolve, 150))

      const file = await window.api.screenshot.capturePrimaryScreen()
      setAttachedFiles((prev) => {
        const byPath = new Map<string, FileMetadata>()
        prev.forEach((f) => byPath.set(f.path, f))
        byPath.set(file.path, file)
        return Array.from(byPath.values())
      })
    } catch (error) {
      logger.error('Failed to capture screen for mini window:', error as Error)
      window.toast.error(t('chat.input.file_error'))
    } finally {
      await window.api.miniWindow.show()
    }
  }, [t])

  const inputActions = useMemo(() => {
    const items = [
      {
        key: 'attach_files',
        label: t('chat.input.upload.upload_from_local'),
        icon: <Paperclip size={16} />,
        onClick: () => void handleAttachFiles()
      },
      {
        key: 'capture_screen',
        label: t('html_artifacts.capture.to_file'),
        icon: <Monitor size={16} />,
        onClick: () => void handleCaptureScreen()
      }
    ]

    return (
      <Dropdown menu={{ items }} trigger={['click']} placement="bottomRight">
        <Tooltip title={t('chat.input.upload.attachment')} mouseEnterDelay={0.8} placement="bottom">
          <ActionIconButton active={attachedFiles.length > 0} aria-label={t('chat.input.upload.attachment')}>
            <Paperclip size={18} />
          </ActionIconButton>
        </Tooltip>
      </Dropdown>
    )
  }, [attachedFiles.length, handleAttachFiles, handleCaptureScreen, t])

  const handleError = (error: Error) => {
    setIsLoading(false)
    setError(error.message)
  }

  const handleSendMessage = useCallback(
    async (prompt?: string) => {
      if (isEmpty(userContent) || !currentTopic.current) {
        return
      }

      try {
        const topicId = currentTopic.current.id

        let uploadedFiles: FileMetadata[] | undefined = undefined
        if (attachedFiles.length > 0) {
          try {
            const filesPath = store.getState().runtime.filesPath
            uploadedFiles = await Promise.all(
              attachedFiles.map(async (file) => {
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
          content: [prompt, userContent].filter(Boolean).join('\n\n'),
          assistant: currentAssistant,
          topic: currentTopic.current,
          files: uploadedFiles
        })

        store.dispatch(newMessagesActions.addMessage({ topicId, message: userMessage }))
        store.dispatch(upsertManyBlocks(blocks))

        const assistantMessage = getAssistantMessage({
          assistant: currentAssistant,
          topic: currentTopic.current
        })
        assistantMessage.askId = userMessage.id
        currentAskId.current = userMessage.id

        store.dispatch(newMessagesActions.addMessage({ topicId, message: assistantMessage }))

        const allMessagesForTopic = selectMessagesForTopic(store.getState(), topicId)
        const userMessageIndex = allMessagesForTopic.findIndex((m) => m?.id === userMessage.id)

        const messagesForContext = allMessagesForTopic
          .slice(0, userMessageIndex + 1)
          .filter((m) => m && !m.status?.includes('ing'))

        let blockId: string | null = null
        let thinkingBlockId: string | null = null
        let thinkingStartTime: number | null = null

        const resolveThinkingDuration = (duration?: number) => {
          if (typeof duration === 'number' && Number.isFinite(duration)) {
            return duration
          }
          if (thinkingStartTime !== null) {
            return Math.max(0, performance.now() - thinkingStartTime)
          }
          return 0
        }

        setIsLoading(true)
        setIsOutputted(false)
        setError(null)

        setIsFirstMessage(false)
        setUserInputText('')
        setAttachedFiles([])

        const newAssistant = cloneDeep(currentAssistant)
        if (!newAssistant.settings) {
          newAssistant.settings = {}
        }
        newAssistant.settings.streamOutput = true
        // 显式关闭这些功能
        newAssistant.webSearchProviderId = undefined
        newAssistant.mcpServers = undefined
        newAssistant.knowledge_bases = undefined
        // replace prompt vars
        newAssistant.prompt = await replacePromptVariables(currentAssistant.prompt, currentAssistant?.model.name)
        // logger.debug('newAssistant', newAssistant)

        const { modelMessages, uiMessages } = await ConversationService.prepareMessagesForModel(
          messagesForContext,
          newAssistant
        )

        await fetchChatCompletion({
          messages: modelMessages,
          assistant: newAssistant,
          requestOptions: {},
          topicId,
          uiMessages: uiMessages,
          onChunkReceived: (chunk: Chunk) => {
            switch (chunk.type) {
              case ChunkType.THINKING_START:
                {
                  setIsOutputted(true)
                  thinkingStartTime = performance.now()
                  if (thinkingBlockId) {
                    store.dispatch(
                      updateOneBlock({ id: thinkingBlockId, changes: { status: MessageBlockStatus.STREAMING } })
                    )
                  } else {
                    const block = createThinkingBlock(assistantMessage.id, '', {
                      status: MessageBlockStatus.STREAMING
                    })
                    thinkingBlockId = block.id
                    store.dispatch(
                      newMessagesActions.updateMessage({
                        topicId,
                        messageId: assistantMessage.id,
                        updates: { blockInstruction: { id: block.id } }
                      })
                    )
                    store.dispatch(upsertOneBlock(block))
                  }
                }
                break
              case ChunkType.THINKING_DELTA:
                {
                  setIsOutputted(true)
                  if (thinkingBlockId) {
                    if (thinkingStartTime === null) {
                      thinkingStartTime = performance.now()
                    }
                    const thinkingDuration = resolveThinkingDuration(chunk.thinking_millsec)
                    throttledBlockUpdate(thinkingBlockId, {
                      content: chunk.text,
                      thinking_millsec: thinkingDuration
                    })
                  }
                }
                break
              case ChunkType.THINKING_COMPLETE:
                {
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
                }
                break
              case ChunkType.TEXT_START:
                {
                  setIsOutputted(true)
                  if (blockId) {
                    store.dispatch(updateOneBlock({ id: blockId, changes: { status: MessageBlockStatus.STREAMING } }))
                  } else {
                    const block = createMainTextBlock(assistantMessage.id, '', {
                      status: MessageBlockStatus.STREAMING
                    })
                    blockId = block.id
                    store.dispatch(
                      newMessagesActions.updateMessage({
                        topicId,
                        messageId: assistantMessage.id,
                        updates: { blockInstruction: { id: block.id } }
                      })
                    )
                    store.dispatch(upsertOneBlock(block))
                  }
                }
                break
              case ChunkType.TEXT_DELTA:
                {
                  setIsOutputted(true)
                  if (blockId) {
                    throttledBlockUpdate(blockId, { content: chunk.text })
                  }
                }
                break

              case ChunkType.TEXT_COMPLETE:
                {
                  if (blockId) {
                    cancelThrottledBlockUpdate(blockId)
                    store.dispatch(
                      updateOneBlock({
                        id: blockId,
                        changes: { content: chunk.text, status: MessageBlockStatus.SUCCESS }
                      })
                    )
                  }
                }
                break
              case ChunkType.ERROR: {
                //stop the thinking timer
                const isAborted = isAbortError(chunk.error)
                const possibleBlockId = thinkingBlockId || blockId
                if (possibleBlockId) {
                  store.dispatch(
                    updateOneBlock({
                      id: possibleBlockId,
                      changes: {
                        status: isAborted ? MessageBlockStatus.PAUSED : MessageBlockStatus.ERROR
                      }
                    })
                  )
                  store.dispatch(
                    newMessagesActions.updateMessage({
                      topicId,
                      messageId: assistantMessage.id,
                      updates: {
                        status: isAborted ? AssistantMessageStatus.PAUSED : AssistantMessageStatus.SUCCESS
                      }
                    })
                  )
                }
                if (!isAborted) {
                  throw new Error(chunk.error.message)
                }
                thinkingStartTime = null
                thinkingBlockId = null
              }
              //fall through
              case ChunkType.BLOCK_COMPLETE:
                setIsLoading(false)
                setIsOutputted(true)
                currentAskId.current = ''
                store.dispatch(
                  newMessagesActions.updateMessage({
                    topicId,
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
        handleError(err instanceof Error ? err : new Error('An error occurred'))
        logger.error('Error fetching result:', err as Error)
      } finally {
        setIsLoading(false)
        setIsOutputted(true)
        currentAskId.current = ''
      }
    },
    [attachedFiles, currentAssistant, t, userContent]
  )

  const handlePause = useCallback(() => {
    if (currentAskId.current) {
      abortCompletion(currentAskId.current)
      setIsLoading(false)
      setIsOutputted(true)
      currentAskId.current = ''
    }
  }, [])

  const handleEsc = useCallback(() => {
    if (isLoading) {
      handlePause()
    } else {
      if (route === 'home') {
        handleCloseWindow()
      } else {
        // Clear the topic messages to reduce memory usage
        if (currentTopic.current) {
          // Clean up any uploaded attachments tied to this ephemeral mini-window thread.
          // This keeps the file storage and db.files reference counts from leaking.
          const messages = selectMessagesForTopic(store.getState(), currentTopic.current.id)
          messages.forEach((m) => deleteMessageFiles(m))
          store.dispatch(newMessagesActions.clearTopicMessages(currentTopic.current.id))
        }

        // Reset the topic
        currentTopic.current = getDefaultTopic(currentAssistant.id)

        setError(null)
        setRoute('home')
        setUserInputText('')
        setHideFirstUserMessage(false)
        setAttachedFiles([])
      }
    }
  }, [isLoading, route, handleCloseWindow, currentAssistant.id, handlePause])

  const handleUseCommand = useCallback(
    (command: QuickAssistantCommand) => {
      setHideFirstUserMessage(!!command.hideSourceMessage)

      const commandPrompt = command.promptKey ? t(command.promptKey) : command.prompt

      switch (command.type) {
        case 'translate':
          setRoute('translate')
          return
        case 'summary':
          setRoute('summary')
          handleSendMessage(commandPrompt)
          return
        case 'explanation':
          setRoute('explanation')
          handleSendMessage(commandPrompt)
          return
        case 'prompt':
          setRoute('chat')
          handleSendMessage(commandPrompt)
          return
        case 'chat':
        default:
          setRoute('chat')
          handleSendMessage()
          return
      }
    },
    [handleSendMessage, t]
  )

  const handleCopy = useCallback(() => {
    if (!currentTopic.current) return

    const messages = selectMessagesForTopic(store.getState(), currentTopic.current.id)
    const lastMessage = last(messages)

    if (lastMessage) {
      const content = getMainTextContent(lastMessage)
      navigator.clipboard.writeText(content)
      window.toast.success(t('message.copy.success'))
    }
  }, [currentTopic, t])

  const handleContinueInMainWindow = useCallback(async () => {
    if (isLoading) return
    if (!currentTopic.current) return

    try {
      const sourceTopicId = currentTopic.current.id
      const messages = selectMessagesForTopic(store.getState(), sourceTopicId)

      // Create a brand new topic and persist the empty shell first (required by clone thunk).
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
          const file = (block as any).file as FileMetadata | undefined
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
  }, [currentAssistant.id, isLoading, t])

  const backgroundColor = useMemo(() => {
    // ONLY MAC: when transparent style + light theme: use vibrancy effect
    // because the dark style under mac's vibrancy effect has not been implemented
    if (isMac && windowStyle === 'transparent' && theme === ThemeMode.light) {
      return 'transparent'
    }
    return 'var(--color-background)'
  }, [windowStyle, theme])

  // Memoize placeholder text
  const inputPlaceholder = useMemo(() => {
    if (referenceText && route === 'home') {
      return t('miniwindow.input.placeholder.title')
    }
    return t('miniwindow.input.placeholder.empty', {
      model: quickAssistantId ? currentAssistant.name : currentAssistant.model.name
    })
  }, [referenceText, route, t, quickAssistantId, currentAssistant])

  // Memoize footer props
  const baseFooterProps = useMemo(
    () => ({
      route,
      loading: isLoading,
      onEsc: handleEsc,
      setIsPinned,
      isPinned
    }),
    [route, isLoading, handleEsc, isPinned]
  )

  switch (route) {
    case 'chat':
    case 'summary':
    case 'explanation':
      return (
        <Container style={{ backgroundColor }} $draggable={draggable}>
          {route === 'chat' && (
            <>
              <InputBar
                text={userInputText}
                assistant={currentAssistant}
                referenceText={referenceText}
                placeholder={inputPlaceholder}
                loading={isLoading}
                handleKeyDown={handleKeyDown}
                handleChange={handleChange}
                actions={inputActions}
                ref={inputBarRef}
              />
              <AttachmentPreview files={attachedFiles} setFiles={setAttachedFiles} />
              <Divider style={{ margin: '10px 0' }} />
            </>
          )}
          {['summary', 'explanation'].includes(route) && (
            <div style={{ marginTop: 10 }}>
              <ClipboardPreview referenceText={referenceText} clearClipboard={clearClipboard} t={t} />
            </div>
          )}
          <ChatWindow
            assistant={currentAssistant}
            topic={currentTopic.current}
            isOutputted={isOutputted}
            hideFirstUserMessage={hideFirstUserMessage}
          />
          {error && <ErrorMsg>{error}</ErrorMsg>}

          <Divider style={{ margin: '10px 0' }} />
          <Footer
            key="footer"
            {...baseFooterProps}
            onCopy={handleCopy}
            onContinueInMainWindow={handleContinueInMainWindow}
          />
        </Container>
      )

    case 'translate':
      return (
        <Container style={{ backgroundColor }} $draggable={draggable}>
          <TranslateWindow text={referenceText} />
          <Divider style={{ margin: '10px 0' }} />
          <Footer key="footer" {...baseFooterProps} />
        </Container>
      )

    // Home
    default:
      return (
        <Container style={{ backgroundColor }} $draggable={draggable}>
          <InputBar
            text={userInputText}
            assistant={currentAssistant}
            referenceText={referenceText}
            placeholder={inputPlaceholder}
            loading={isLoading}
            handleKeyDown={handleKeyDown}
            handleChange={handleChange}
            actions={inputActions}
            ref={inputBarRef}
          />
          <AttachmentPreview files={attachedFiles} setFiles={setAttachedFiles} />
          <Divider style={{ margin: '10px 0' }} />
          <ClipboardPreview referenceText={referenceText} clearClipboard={clearClipboard} t={t} />
          <Main>
            <FeatureMenus onUseCommand={handleUseCommand} text={userContent} ref={featureMenusRef} />
          </Main>
          <Divider style={{ margin: '10px 0' }} />
          <Footer
            key="footer"
            {...baseFooterProps}
            canUseBackspace={userInputText.length > 0 || clipboardText.length === 0}
            clearClipboard={clearClipboard}
          />
        </Container>
      )
  }
}

const Container = styled.div<{ $draggable: boolean }>`
  display: flex;
  flex: 1;
  height: 100%;
  width: 100%;
  flex-direction: column;
  -webkit-app-region: ${({ $draggable }) => ($draggable ? 'drag' : 'no-drag')};
  padding: 8px 10px;
`

const Main = styled.main`
  display: flex;
  flex-direction: column;

  flex: 1;
  overflow: hidden;
`

const ErrorMsg = styled.div`
  color: var(--color-error);
  background: rgba(255, 0, 0, 0.15);
  border: 1px solid var(--color-error);
  padding: 8px 12px;
  border-radius: 4px;
  margin-bottom: 12px;
  font-size: 13px;
  word-break: break-all;
`

export default HomeWindow
