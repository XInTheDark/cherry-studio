import Scrollbar from '@renderer/components/Scrollbar'
import type { Assistant, Topic } from '@renderer/types'
import type { FC } from 'react'
import styled from 'styled-components'

import Messages from './components/Messages'
interface Props {
  assistant: Assistant | null
  topic: Topic | null
  isOutputted: boolean
  hideFirstUserMessage?: boolean
}

const ChatWindow: FC<Props> = ({ assistant, topic, isOutputted, hideFirstUserMessage }) => {
  if (!assistant || !topic) return null

  return (
    <Main className="bubble">
      <Messages
        assistant={assistant}
        topic={topic}
        isOutputted={isOutputted}
        hideFirstUserMessage={hideFirstUserMessage}
      />
    </Main>
  )
}

const Main = styled(Scrollbar)`
  width: 100%;
  display: flex;
  flex-direction: row;
  justify-content: flex-start;
  margin-bottom: auto;
  -webkit-app-region: none;
  background-color: transparent !important;
  max-height: 100%;
`

export default ChatWindow
