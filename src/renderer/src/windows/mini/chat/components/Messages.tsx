import { LoadingOutlined } from '@ant-design/icons'
import Scrollbar from '@renderer/components/Scrollbar'
import { useTopicMessages } from '@renderer/hooks/useMessageOperations'
import type { Assistant, Topic } from '@renderer/types'
import type { FC } from 'react'
import { useMemo } from 'react'
import styled from 'styled-components'

import MessageItem from './Message'

interface Props {
  assistant: Assistant
  topic: Topic
  isOutputted: boolean
  hideFirstUserMessage?: boolean
}

interface ContainerProps {
  right?: boolean
}

const Messages: FC<Props> = ({ assistant, topic, isOutputted, hideFirstUserMessage }) => {
  const messages = useTopicMessages(topic.id)

  const hiddenUserMessageId = useMemo(() => {
    if (!hideFirstUserMessage) return null
    const firstUserMessage = messages.find((m) => m.role === 'user')
    return firstUserMessage?.id ?? null
  }, [hideFirstUserMessage, messages])

  return (
    <Container id="messages" key={assistant.id}>
      {!isOutputted && <LoadingOutlined style={{ fontSize: 16 }} spin />}
      {[...messages]
        .reverse()
        .filter((m) => (hiddenUserMessageId ? m.id !== hiddenUserMessageId : true))
        .map((message) => (
          <MessageItem key={message.id} message={message} />
        ))}
    </Container>
  )
}

const Container = styled(Scrollbar)<ContainerProps>`
  display: flex;
  flex-direction: column-reverse;
  align-items: center;
  padding-bottom: 20px;
  overflow-x: hidden;
  min-width: 100%;
  background-color: transparent !important;
`

export default Messages
