import ModelAvatar from '@renderer/components/Avatar/ModelAvatar'
import { useTimer } from '@renderer/hooks/useTimer'
import type { Assistant } from '@renderer/types'
import { Input as AntdInput } from 'antd'
import type { InputRef } from 'rc-input/lib/interface'
import React, { useRef } from 'react'
import styled from 'styled-components'

interface InputBarProps {
  text: string
  assistant: Assistant
  referenceText: string
  placeholder: string
  loading: boolean
  handleKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  handleChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  actions?: React.ReactNode
}

const InputBar = ({
  ref,
  text,
  assistant,
  placeholder,
  loading,
  handleKeyDown,
  handleChange,
  actions
}: InputBarProps & { ref?: React.RefObject<HTMLDivElement | null> }) => {
  const inputRef = useRef<InputRef>(null)
  const { setTimeoutTimer } = useTimer()
  if (!loading) {
    setTimeoutTimer('focus', () => inputRef.current?.input?.focus(), 0)
  }
  return (
    <InputWrapper ref={ref}>
      {assistant.model && <ModelAvatar model={assistant.model} size={30} />}
      <Input
        value={text}
        placeholder={placeholder}
        variant="borderless"
        autoFocus
        onKeyDown={handleKeyDown}
        onChange={handleChange}
        ref={inputRef}
      />
      {actions ? <Actions className="nodrag">{actions}</Actions> : null}
    </InputWrapper>
  )
}
InputBar.displayName = 'InputBar'

const InputWrapper = styled.div`
  display: flex;
  align-items: center;
  margin-top: 10px;
`

const Actions = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  -webkit-app-region: no-drag;
`

const Input = styled(AntdInput)`
  background: none;
  border: none;
  -webkit-app-region: no-drag;
  font-size: 18px;
`

export default InputBar
