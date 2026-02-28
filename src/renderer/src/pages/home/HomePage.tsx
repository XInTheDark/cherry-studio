import { loggerService } from '@logger'
import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import { useAgentSessionInitializer } from '@renderer/hooks/agents/useAgentSessionInitializer'
import { useAssistants } from '@renderer/hooks/useAssistant'
import { useRuntime } from '@renderer/hooks/useRuntime'
import { useNavbarPosition, useSettings } from '@renderer/hooks/useSettings'
import { useActiveTopic } from '@renderer/hooks/useTopic'
import NavigationService from '@renderer/services/NavigationService'
import { newMessagesActions } from '@renderer/store/newMessage'
import { setActiveAgentId, setActiveTopicOrSessionAction } from '@renderer/store/runtime'
import type { Assistant, Topic } from '@renderer/types'
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, SECOND_MIN_WINDOW_WIDTH } from '@shared/config/constant'
import { AnimatePresence, motion } from 'motion/react'
import type { FC } from 'react'
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch } from 'react-redux'
import { useLocation, useNavigate } from 'react-router-dom'
import styled from 'styled-components'

import Chat, { type ConversationTabItem } from './Chat'
import Navbar from './Navbar'
import HomeTabs from './Tabs'

let _activeAssistant: Assistant
const logger = loggerService.withContext('HomePage')

const CONVERSATION_TABS_STORAGE_KEY = 'home:conversation-tabs:v1'

interface PersistedConversationTabs {
  topicIds: string[]
  activeTopicId?: string
}

const areTopicIdsEqual = (left: string[], right: string[]) => {
  if (left.length !== right.length) {
    return false
  }
  return left.every((item, index) => item === right[index])
}

const normalizeTopicIds = (topicIds: unknown): string[] => {
  if (!Array.isArray(topicIds)) {
    return []
  }

  const filteredTopicIds = topicIds.filter(
    (topicId): topicId is string => typeof topicId === 'string' && topicId.length > 0
  )
  return Array.from(new Set(filteredTopicIds))
}

const loadPersistedConversationTabs = (): PersistedConversationTabs => {
  try {
    const rawData = localStorage.getItem(CONVERSATION_TABS_STORAGE_KEY)
    if (!rawData) {
      return { topicIds: [] }
    }

    const parsedData = JSON.parse(rawData) as { topicIds?: unknown; activeTopicId?: unknown }
    return {
      topicIds: normalizeTopicIds(parsedData.topicIds),
      activeTopicId: typeof parsedData.activeTopicId === 'string' ? parsedData.activeTopicId : undefined
    }
  } catch (error) {
    logger.warn('Failed to parse persisted conversation tabs. Resetting to defaults.', { error })
    return { topicIds: [] }
  }
}

const persistConversationTabs = (payload: PersistedConversationTabs) => {
  try {
    localStorage.setItem(CONVERSATION_TABS_STORAGE_KEY, JSON.stringify(payload))
  } catch (error) {
    logger.warn('Failed to persist conversation tabs.', { error })
  }
}

const HomePage: FC = () => {
  const { assistants } = useAssistants()
  const navigate = useNavigate()
  const { isLeftNavbar } = useNavbarPosition()

  // Initialize agent session hook
  useAgentSessionInitializer()

  const location = useLocation()
  const state = location.state
  const persistedTabsRef = useRef<PersistedConversationTabs>(loadPersistedConversationTabs())
  const restoredActiveTopicIdRef = useRef<string | null>(persistedTabsRef.current.activeTopicId ?? null)

  const [activeAssistant, _setActiveAssistant] = useState<Assistant>(
    state?.assistant || _activeAssistant || assistants[0]
  )
  const [conversationTabTopicIds, setConversationTabTopicIds] = useState<string[]>(persistedTabsRef.current.topicIds)
  const { activeTopic, setActiveTopic: _setActiveTopic } = useActiveTopic(activeAssistant?.id ?? '', state?.topic)
  const { showAssistants, showTopics, topicPosition } = useSettings()
  const dispatch = useDispatch()
  const { chat } = useRuntime()
  const { activeTopicOrSession } = chat

  _activeAssistant = activeAssistant

  const topicLookup = useMemo(() => {
    const lookup = new Map<string, { assistant: Assistant; topic: Topic }>()
    assistants.forEach((assistant) => {
      assistant.topics.forEach((topic) => {
        lookup.set(topic.id, { assistant, topic })
      })
    })
    return lookup
  }, [assistants])

  const setActiveAssistant = useCallback(
    // TODO: allow to set it as null.
    (newAssistant: Assistant, preferredTopic?: Topic) => {
      const nextTopic = preferredTopic || newAssistant.topics[0]

      if (newAssistant.id === activeAssistant?.id) {
        if (preferredTopic && nextTopic) {
          startTransition(() => {
            _setActiveTopic((prev) => (nextTopic.id === prev.id ? prev : nextTopic))
            dispatch(newMessagesActions.setTopicFulfilled({ topicId: nextTopic.id, fulfilled: false }))
            dispatch(setActiveTopicOrSessionAction('topic'))
          })
        }
        return
      }

      startTransition(() => {
        _setActiveAssistant(newAssistant)
        if (newAssistant.id !== 'fake') {
          dispatch(setActiveAgentId(null))
        }
        // 同步更新 active topic，避免不必要的重新渲染
        if (nextTopic) {
          _setActiveTopic((prev) => (nextTopic.id === prev.id ? prev : nextTopic))
        }
      })
    },
    [_setActiveTopic, activeAssistant?.id, dispatch]
  )

  const setActiveTopic = useCallback(
    (newTopic: Topic) => {
      startTransition(() => {
        _setActiveTopic((prev) => (newTopic?.id === prev.id ? prev : newTopic))
        dispatch(newMessagesActions.setTopicFulfilled({ topicId: newTopic.id, fulfilled: false }))
        dispatch(setActiveTopicOrSessionAction('topic'))
      })
    },
    [_setActiveTopic, dispatch]
  )

  const switchConversationTab = useCallback(
    (topicId: string) => {
      const target = topicLookup.get(topicId)
      if (!target) {
        return
      }

      if (target.assistant.id === activeAssistant?.id) {
        setActiveTopic(target.topic)
        return
      }

      setActiveAssistant(target.assistant, target.topic)
    },
    [activeAssistant?.id, setActiveAssistant, setActiveTopic, topicLookup]
  )

  const closeConversationTab = useCallback(
    (topicId: string) => {
      if (conversationTabTopicIds.length <= 1) {
        return
      }

      const closingIndex = conversationTabTopicIds.indexOf(topicId)
      if (closingIndex === -1) {
        return
      }

      const nextTopicIds = conversationTabTopicIds.filter((id) => id !== topicId)
      setConversationTabTopicIds(nextTopicIds)

      if (activeTopic?.id !== topicId) {
        return
      }

      const fallbackTopicId = nextTopicIds[closingIndex] ?? nextTopicIds[closingIndex - 1] ?? nextTopicIds[0]
      fallbackTopicId && switchConversationTab(fallbackTopicId)
    },
    [activeTopic?.id, conversationTabTopicIds, switchConversationTab]
  )

  const conversationTabs = useMemo<ConversationTabItem[]>(
    () =>
      conversationTabTopicIds
        .map((topicId) => topicLookup.get(topicId))
        .filter((value): value is { assistant: Assistant; topic: Topic } => Boolean(value))
        .map(({ assistant, topic }) => ({
          topicId: topic.id,
          assistantId: assistant.id,
          topicName: topic.name,
          assistantName: assistant.name
        })),
    [conversationTabTopicIds, topicLookup]
  )

  useEffect(() => {
    NavigationService.setNavigate(navigate)
  }, [navigate])

  useEffect(() => {
    if (state?.assistant && state?.topic) {
      setActiveAssistant(state.assistant, state.topic)
      return
    }

    state?.assistant && setActiveAssistant(state?.assistant)
    state?.topic && setActiveTopic(state?.topic)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  useEffect(() => {
    if (!activeTopic?.id) {
      return
    }

    setConversationTabTopicIds((previousTopicIds) =>
      previousTopicIds.includes(activeTopic.id) ? previousTopicIds : [...previousTopicIds, activeTopic.id]
    )
  }, [activeTopic?.id])

  useEffect(() => {
    if (!activeTopic?.id) {
      return
    }

    setConversationTabTopicIds((previousTopicIds) => {
      const validTopicIds = previousTopicIds.filter((topicId) => topicLookup.has(topicId))

      if (!validTopicIds.includes(activeTopic.id)) {
        validTopicIds.push(activeTopic.id)
      }

      return areTopicIdsEqual(previousTopicIds, validTopicIds) ? previousTopicIds : validTopicIds
    })
  }, [activeTopic?.id, topicLookup])

  useEffect(() => {
    const restoredTopicId = restoredActiveTopicIdRef.current
    if (!restoredTopicId) {
      return
    }

    const target = topicLookup.get(restoredTopicId)
    if (!target) {
      if (assistants.length > 0) {
        restoredActiveTopicIdRef.current = null
      }
      return
    }

    restoredActiveTopicIdRef.current = null

    if (target.assistant.id === activeAssistant?.id) {
      target.topic.id !== activeTopic?.id && setActiveTopic(target.topic)
      return
    }

    setActiveAssistant(target.assistant, target.topic)
  }, [activeAssistant?.id, activeTopic?.id, assistants.length, setActiveAssistant, setActiveTopic, topicLookup])

  useEffect(() => {
    persistConversationTabs({
      topicIds: conversationTabTopicIds,
      activeTopicId: activeTopic?.id
    })
  }, [activeTopic?.id, conversationTabTopicIds])

  useEffect(() => {
    const canMinimize = topicPosition == 'left' ? !showAssistants : !showAssistants && !showTopics
    window.api.window.setMinimumSize(canMinimize ? SECOND_MIN_WINDOW_WIDTH : MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)

    return () => {
      window.api.window.resetMinimumSize()
    }
  }, [showAssistants, showTopics, topicPosition])

  return (
    <Container id="home-page">
      {isLeftNavbar && (
        <Navbar
          activeAssistant={activeAssistant}
          activeTopic={activeTopic}
          setActiveTopic={setActiveTopic}
          setActiveAssistant={setActiveAssistant}
          position="left"
          activeTopicOrSession={activeTopicOrSession}
        />
      )}
      <ContentContainer id={isLeftNavbar ? 'content-container' : undefined}>
        <AnimatePresence initial={false}>
          {showAssistants && (
            <ErrorBoundary>
              <motion.div
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: 'var(--assistants-width)', opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={{ duration: 0.3, ease: 'easeInOut' }}
                style={{ overflow: 'hidden' }}>
                <HomeTabs
                  activeAssistant={activeAssistant}
                  activeTopic={activeTopic}
                  setActiveAssistant={setActiveAssistant}
                  setActiveTopic={setActiveTopic}
                  position="left"
                />
              </motion.div>
            </ErrorBoundary>
          )}
        </AnimatePresence>
        <ErrorBoundary>
          <Chat
            assistant={activeAssistant}
            activeTopic={activeTopic}
            setActiveTopic={setActiveTopic}
            setActiveAssistant={setActiveAssistant}
            conversationTabs={conversationTabs}
            onSwitchConversationTab={switchConversationTab}
            onCloseConversationTab={closeConversationTab}
          />
        </ErrorBoundary>
      </ContentContainer>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  [navbar-position='left'] & {
    max-width: calc(100vw - var(--sidebar-width));
  }
  [navbar-position='top'] & {
    max-width: 100vw;
  }
`

const ContentContainer = styled.div`
  display: flex;
  flex: 1;
  flex-direction: row;
  overflow: hidden;
`

export default HomePage
