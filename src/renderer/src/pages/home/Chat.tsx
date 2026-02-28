import { loggerService } from '@logger'
import type { ContentSearchRef } from '@renderer/components/ContentSearch'
import { ContentSearch } from '@renderer/components/ContentSearch'
import HorizontalScrollContainer from '@renderer/components/HorizontalScrollContainer'
import { HStack } from '@renderer/components/Layout'
import MultiSelectActionPopup from '@renderer/components/Popups/MultiSelectionPopup'
import PromptPopup from '@renderer/components/Popups/PromptPopup'
import { useCreateDefaultSession } from '@renderer/hooks/agents/useCreateDefaultSession'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useChatContext } from '@renderer/hooks/useChatContext'
import { useRuntime } from '@renderer/hooks/useRuntime'
import { useNavbarPosition, useSettings } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useShowAssistants, useShowTopics } from '@renderer/hooks/useStore'
import { useTimer } from '@renderer/hooks/useTimer'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import type { Assistant, Topic } from '@renderer/types'
import { classNames } from '@renderer/utils'
import type { MenuProps } from 'antd'
import { Alert, Dropdown, Flex } from 'antd'
import { debounce } from 'lodash'
import { X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import type { FC } from 'react'
import React, { useCallback, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import ChatNavbar from './ChatNavbar'
import MessagesTocPanel from './components/MessagesTocPanel'
import AgentSessionInputbar from './Inputbar/AgentSessionInputbar'
import Inputbar from './Inputbar/Inputbar'
import AgentSessionMessages from './Messages/AgentSessionMessages'
import ChatNavigation from './Messages/ChatNavigation'
import Messages from './Messages/Messages'
import ThreadHighlightTooltip from './Messages/Threads/ThreadHighlightTooltip'
import ThreadSelectionTracker from './Messages/Threads/ThreadSelectionTracker'
import ThreadSidebar from './Messages/Threads/ThreadSidebar'
import Tabs from './Tabs'

const logger = loggerService.withContext('Chat')

export interface ConversationTabItem {
  topicId: string
  assistantId: string
  topicName: string
  assistantName: string
}

interface Props {
  assistant: Assistant
  activeTopic: Topic
  setActiveTopic: (topic: Topic) => void
  setActiveAssistant: (assistant: Assistant) => void
  conversationTabs: ConversationTabItem[]
  onSwitchConversationTab: (topicId: string) => void
  onCloseConversationTab: (topicId: string) => void
  onCloseOtherConversationTabs: (topicId: string) => void
  onCloseConversationTabsToLeft: (topicId: string) => void
  onCloseConversationTabsToRight: (topicId: string) => void
  onCloseAllConversationTabs: (fallbackTopicId?: string) => void
}

const Chat: FC<Props> = (props) => {
  const {
    assistant: activeAssistant,
    activeTopic,
    setActiveTopic,
    setActiveAssistant,
    conversationTabs,
    onSwitchConversationTab,
    onCloseConversationTab,
    onCloseOtherConversationTabs,
    onCloseConversationTabsToLeft,
    onCloseConversationTabsToRight,
    onCloseAllConversationTabs
  } = props
  const { assistant, updateTopic } = useAssistant(activeAssistant.id)
  const { t } = useTranslation()
  const { topicPosition, messageStyle, messageNavigation } = useSettings()
  const { showTopics } = useShowTopics()
  const { isMultiSelectMode } = useChatContext(activeTopic)
  const { isTopNavbar } = useNavbarPosition()
  const chatMaxWidth = useChatMaxWidth()
  const { chat } = useRuntime()
  const { activeTopicOrSession, activeAgentId, activeSessionIdMap } = chat
  const activeSessionId = activeAgentId ? activeSessionIdMap[activeAgentId] : null
  const { apiServer } = useSettings()
  const sessionAgentId = activeTopicOrSession === 'session' ? activeAgentId : null
  const { createDefaultSession } = useCreateDefaultSession(sessionAgentId)

  const mainRef = React.useRef<HTMLDivElement>(null)
  const contentSearchRef = React.useRef<ContentSearchRef>(null)
  const [filterIncludeUser, setFilterIncludeUser] = useState(false)
  const [isChatFindActive, setIsChatFindActive] = useState(false)
  const [isMessagesTocOpen, setIsMessagesTocOpen] = useState(false)

  const { setTimeoutTimer } = useTimer()

  useHotkeys('esc', () => {
    contentSearchRef.current?.disable()
  })

  useShortcut('search_message_in_chat', () => {
    try {
      const selectedText = window.getSelection()?.toString().trim()
      contentSearchRef.current?.enable(selectedText)
    } catch (error) {
      logger.error('Error enabling content search:', error as Error)
    }
  })

  useShortcut('rename_topic', async () => {
    const topic = activeTopic
    if (!topic) return

    EventEmitter.emit(EVENT_NAMES.SHOW_TOPIC_SIDEBAR)

    const name = await PromptPopup.show({
      title: t('chat.topics.edit.title'),
      message: '',
      defaultValue: topic.name || '',
      extraNode: <div style={{ color: 'var(--color-text-3)', marginTop: 8 }}>{t('chat.topics.edit.title_tip')}</div>
    })
    if (name && topic.name !== name) {
      const updatedTopic = { ...topic, name, isNameManuallyEdited: true }
      updateTopic(updatedTopic as Topic)
    }
  })

  useShortcut(
    'new_topic',
    () => {
      if (activeTopicOrSession !== 'session' || !activeAgentId) {
        return
      }
      void createDefaultSession()
    },
    {
      enabled: activeTopicOrSession === 'session',
      preventDefault: true,
      enableOnFormTags: true
    }
  )

  const contentSearchFilter: NodeFilter = {
    acceptNode(node) {
      const container = node.parentElement?.closest('.message-content-container')
      if (!container) return NodeFilter.FILTER_REJECT

      const message = container.closest('.message')
      if (!message) return NodeFilter.FILTER_REJECT

      if (filterIncludeUser) {
        return NodeFilter.FILTER_ACCEPT
      }
      if (message.classList.contains('message-assistant')) {
        return NodeFilter.FILTER_ACCEPT
      }
      return NodeFilter.FILTER_REJECT
    }
  }

  const userOutlinedItemClickHandler = () => {
    setFilterIncludeUser(!filterIncludeUser)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeoutTimer(
          'userOutlinedItemClickHandler',
          () => {
            contentSearchRef.current?.search()
            contentSearchRef.current?.focus()
          },
          0
        )
      })
    })
  }

  let firstUpdateCompleted = false
  const firstUpdateOrNoFirstUpdateHandler = debounce(() => {
    contentSearchRef.current?.silentSearch()
  }, 10)

  const messagesComponentUpdateHandler = () => {
    if (firstUpdateCompleted) {
      firstUpdateOrNoFirstUpdateHandler()
    }
  }

  const messagesComponentFirstUpdateHandler = () => {
    setTimeoutTimer('messagesComponentFirstUpdateHandler', () => (firstUpdateCompleted = true), 300)
    firstUpdateOrNoFirstUpdateHandler()
  }

  const mainHeight = isTopNavbar ? 'calc(100vh - var(--navbar-height) - 6px)' : 'calc(100vh - var(--navbar-height))'
  const canCloseConversationTab = conversationTabs.length > 1
  const showConversationTabs = conversationTabs.length > 1
  const activeConversationIndex = conversationTabs.findIndex((tab) => tab.topicId === activeTopic.id)

  const getConversationTabMenuItems = useCallback(
    (topicId: string): MenuProps['items'] => {
      const topicIndex = conversationTabs.findIndex((tab) => tab.topicId === topicId)
      const hasTabsOnLeft = topicIndex > 0
      const hasTabsOnRight = topicIndex !== -1 && topicIndex < conversationTabs.length - 1

      return [
        {
          key: 'close',
          label: t('common.close'),
          disabled: !canCloseConversationTab,
          onClick: () => onCloseConversationTab(topicId)
        },
        {
          key: 'closeOthers',
          label: 'Close Others',
          disabled: !canCloseConversationTab,
          onClick: () => onCloseOtherConversationTabs(topicId)
        },
        {
          key: 'closeLeft',
          label: 'Close Tabs to the Left',
          disabled: !canCloseConversationTab || !hasTabsOnLeft,
          onClick: () => onCloseConversationTabsToLeft(topicId)
        },
        {
          key: 'closeRight',
          label: 'Close Tabs to the Right',
          disabled: !canCloseConversationTab || !hasTabsOnRight,
          onClick: () => onCloseConversationTabsToRight(topicId)
        },
        {
          key: 'closeAll',
          label: 'Close All Tabs',
          disabled: !canCloseConversationTab,
          onClick: () => onCloseAllConversationTabs(topicId)
        }
      ]
    },
    [
      canCloseConversationTab,
      conversationTabs,
      onCloseAllConversationTabs,
      onCloseConversationTab,
      onCloseConversationTabsToLeft,
      onCloseConversationTabsToRight,
      onCloseOtherConversationTabs,
      t
    ]
  )

  // TODO: more info
  const AgentInvalid = useCallback(() => {
    return <Alert type="warning" message="Select an agent" style={{ margin: '5px 16px' }} />
  }, [])

  // TODO: more info
  const SessionInvalid = useCallback(() => {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <Alert type="warning" message="Create a session" style={{ margin: '5px 16px' }} />
      </div>
    )
  }, [])

  useHotkeys(
    'meta+w,ctrl+w',
    (event) => {
      if (canCloseConversationTab && activeConversationIndex !== -1) {
        event.preventDefault()
        event.stopPropagation()
        onCloseConversationTab(activeTopic.id)
        return
      }

      event.preventDefault()
      event.stopPropagation()
      void window.api.windowControls.close()
    },
    {
      enableOnFormTags: true
    },
    [activeConversationIndex, activeTopic.id, canCloseConversationTab, onCloseConversationTab]
  )

  return (
    <Container id="chat" className={classNames([messageStyle, { 'multi-select-mode': isMultiSelectMode }])}>
      <HStack>
        <motion.div
          animate={{
            marginRight:
              topicPosition === 'right' && showTopics ? 'calc(var(--assistants-width) + var(--border-width))' : 0
          }}
          transition={{ duration: 0.3, ease: 'easeInOut' }}
          style={{ flex: 1, display: 'flex', minWidth: 0 }}>
          <Main
            ref={mainRef}
            id="chat-main"
            vertical
            flex={1}
            justify="space-between"
            style={{ maxWidth: chatMaxWidth, height: mainHeight }}>
            <ChatNavbar
              activeAssistant={activeAssistant}
              activeTopic={activeTopic}
              setActiveTopic={setActiveTopic}
              setActiveAssistant={setActiveAssistant}
              position="left"
              messagesTocOpen={isMessagesTocOpen}
              onToggleMessagesToc={() => setIsMessagesTocOpen((prev) => !prev)}
            />
            {activeTopicOrSession === 'topic' && showConversationTabs && (
              <ConversationTabsContainer>
                <HorizontalScrollContainer dependencies={[conversationTabs, activeTopic.id]} gap="6px">
                  {conversationTabs.map((tab) => (
                    <Dropdown
                      key={tab.topicId}
                      menu={{ items: getConversationTabMenuItems(tab.topicId) }}
                      trigger={['contextMenu']}>
                      <ConversationTabButton
                        $active={tab.topicId === activeTopic.id}
                        title={`${tab.topicName}${tab.assistantName ? ` · ${tab.assistantName}` : ''}`}
                        onClick={() => onSwitchConversationTab(tab.topicId)}
                        onAuxClick={(event) => {
                          if (event.button !== 1 || !canCloseConversationTab) {
                            return
                          }
                          event.preventDefault()
                          event.stopPropagation()
                          onCloseConversationTab(tab.topicId)
                        }}>
                        <ConversationTabTitle>{tab.topicName}</ConversationTabTitle>
                        {canCloseConversationTab && (
                          <ConversationTabCloseButton
                            onClick={(event) => {
                              event.stopPropagation()
                              onCloseConversationTab(tab.topicId)
                            }}>
                            <X size={12} />
                          </ConversationTabCloseButton>
                        )}
                      </ConversationTabButton>
                    </Dropdown>
                  ))}
                </HorizontalScrollContainer>
              </ConversationTabsContainer>
            )}
            <div className="flex flex-1 flex-col justify-between" style={{ minHeight: 0 }}>
              {activeTopicOrSession === 'topic' && (
                <>
                  <div style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0 }}>
                    {isMessagesTocOpen && (
                      <MessagesTocPanel
                        topic={activeTopic}
                        onClose={() => setIsMessagesTocOpen(false)}
                        containerId="messages"
                      />
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
                      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
                        <Messages
                          key={activeTopic.id}
                          assistant={assistant}
                          topic={activeTopic}
                          setActiveTopic={setActiveTopic}
                          onComponentUpdate={messagesComponentUpdateHandler}
                          onFirstUpdate={messagesComponentFirstUpdateHandler}
                          autoExpandForSearch={isChatFindActive}
                        />
                        <ContentSearch
                          ref={contentSearchRef}
                          searchTarget={mainRef as React.RefObject<HTMLElement>}
                          filter={contentSearchFilter}
                          includeUser={filterIncludeUser}
                          onIncludeUserChange={userOutlinedItemClickHandler}
                          onActiveChange={setIsChatFindActive}
                        />
                      </div>

                      {messageNavigation === 'buttons' && <ChatNavigation containerId="messages" />}

                      <div style={{ marginTop: 'auto' }}>
                        <Inputbar assistant={assistant} setActiveTopic={setActiveTopic} topic={activeTopic} />
                      </div>
                    </div>
                    <ThreadSidebar />
                  </div>
                  <ThreadSelectionTracker />
                  <ThreadHighlightTooltip />
                </>
              )}
              {activeTopicOrSession === 'session' && !activeAgentId && <AgentInvalid />}
              {activeTopicOrSession === 'session' && activeAgentId && !activeSessionId && <SessionInvalid />}
              {activeTopicOrSession === 'session' && activeAgentId && activeSessionId && (
                <>
                  {!apiServer.enabled ? (
                    <Alert type="warning" message={t('agent.warning.enable_server')} style={{ margin: '5px 16px' }} />
                  ) : (
                    <AgentSessionMessages agentId={activeAgentId} sessionId={activeSessionId} />
                  )}
                  {messageNavigation === 'buttons' && <ChatNavigation containerId="messages" />}
                  <AgentSessionInputbar agentId={activeAgentId} sessionId={activeSessionId} />
                </>
              )}
              {isMultiSelectMode && <MultiSelectActionPopup topic={activeTopic} />}
            </div>
          </Main>
        </motion.div>
        <AnimatePresence initial={false}>
          {topicPosition === 'right' && showTopics && (
            <motion.div
              key="right-tabs"
              initial={{ x: 'var(--assistants-width)' }}
              animate={{ x: 0 }}
              exit={{ x: 'var(--assistants-width)' }}
              transition={{ duration: 0.3, ease: 'easeInOut' }}
              style={{
                position: 'absolute',
                right: 0,
                top: isTopNavbar ? 0 : 'calc(var(--navbar-height) + 1px)',
                width: 'var(--assistants-width)',
                height: '100%',
                zIndex: 10
              }}>
              <Tabs
                activeAssistant={assistant}
                activeTopic={activeTopic}
                setActiveAssistant={setActiveAssistant}
                setActiveTopic={setActiveTopic}
                position="right"
              />
            </motion.div>
          )}
        </AnimatePresence>
      </HStack>
    </Container>
  )
}

export const useChatMaxWidth = () => {
  const { showTopics, topicPosition } = useSettings()
  const { isLeftNavbar, isTopNavbar } = useNavbarPosition()
  const { showAssistants } = useShowAssistants()
  const showRightTopics = showTopics && topicPosition === 'right'
  const minusAssistantsWidth = showAssistants ? '- var(--assistants-width)' : ''
  const minusRightTopicsWidth = showRightTopics ? '- var(--assistants-width)' : ''
  const minusBorderWidth = isTopNavbar ? (showTopics ? '- 12px' : '- 6px') : ''
  const sidebarWidth = isLeftNavbar ? '- var(--sidebar-width)' : ''
  return `calc(100vw ${sidebarWidth} ${minusAssistantsWidth} ${minusRightTopicsWidth} ${minusBorderWidth})`
}

const Container = styled.div`
  display: flex;
  flex-direction: column;
  height: calc(100vh - var(--navbar-height));
  flex: 1;
  [navbar-position='top'] & {
    height: calc(100vh - var(--navbar-height) - 6px);
    background-color: var(--color-background);
    border-top-left-radius: 10px;
    border-bottom-left-radius: 10px;
    overflow: hidden;
  }
`

const Main = styled(Flex)`
  [navbar-position='left'] & {
    height: calc(100vh - var(--navbar-height));
  }
  transform: translateZ(0);
  position: relative;
`

const ConversationTabsContainer = styled.div`
  display: flex;
  align-items: center;
  min-height: 36px;
  padding: 0 10px 6px;
`

const ConversationTabButton = styled.button<{ $active: boolean }>`
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 88px;
  max-width: 220px;
  height: 30px;
  padding: 0 6px 0 10px;
  border: none;
  border-radius: var(--list-item-border-radius);
  background: ${({ $active }) => ($active ? 'var(--color-list-item)' : 'transparent')};
  color: var(--color-text);
  cursor: pointer;
  transition: background 0.2s;

  &:hover {
    background: var(--color-list-item);
  }
`

const ConversationTabTitle = styled.span`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
`

const ConversationTabCloseButton = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-2);
  cursor: pointer;

  &:hover {
    background: var(--color-background-mute);
    color: var(--color-text);
  }
`

export default Chat
