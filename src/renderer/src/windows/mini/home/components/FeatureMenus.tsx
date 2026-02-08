import { EnterOutlined } from '@ant-design/icons'
import Scrollbar from '@renderer/components/Scrollbar'
import { useAppSelector } from '@renderer/store'
import type { QuickAssistantCommand } from '@renderer/store/settings'
import { DEFAULT_QUICK_ASSISTANT_COMMANDS } from '@renderer/store/settings'
import { Col } from 'antd'
import { FileText, Languages, Lightbulb, MessageSquare } from 'lucide-react'
import { DynamicIcon, iconNames } from 'lucide-react/dynamic'
import { useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface FeatureMenusProps {
  onUseCommand: (command: QuickAssistantCommand) => void
  onFocusChange?: (focused: boolean) => void
  disabled?: boolean
}

export interface FeatureMenusRef {
  nextFeature: () => void
  prevFeature: () => void
  useFeature: () => void
  resetSelectedIndex: () => void
  focus: () => void
}

const FeatureMenus = ({
  ref,
  onUseCommand,
  onFocusChange,
  disabled
}: FeatureMenusProps & { ref?: React.RefObject<FeatureMenusRef | null> }) => {
  const { t } = useTranslation()
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [isFocused, setIsFocused] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const quickAssistantCommands =
    useAppSelector((state) => state.settings.quickAssistantCommands) || DEFAULT_QUICK_ASSISTANT_COMMANDS

  const features = useMemo(() => {
    const enabledCommands = (quickAssistantCommands || []).filter((c) => c.enabled)

    const getIcon = (command: QuickAssistantCommand) => {
      if (command.icon && iconNames.includes(command.icon as (typeof iconNames)[number])) {
        return <DynamicIcon name={command.icon as (typeof iconNames)[number]} size={16} color="var(--color-text)" />
      }

      switch (command.type) {
        case 'chat':
          return <MessageSquare size={16} color="var(--color-text)" />
        case 'translate':
          return <Languages size={16} color="var(--color-text)" />
        case 'summary':
          return <FileText size={16} color="var(--color-text)" />
        case 'explanation':
        case 'prompt':
        default:
          return <Lightbulb size={16} color="var(--color-text)" />
      }
    }

    return enabledCommands.map((command) => ({
      command,
      icon: getIcon(command),
      title: command.titleKey ? t(command.titleKey) : command.title || '',
      onClick: () => {
        containerRef.current?.focus()
        onUseCommand(command)
      }
    }))
  }, [onUseCommand, quickAssistantCommands, t])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (disabled) return
      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault()
          if (features.length === 0) return
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : features.length - 1))
          break
        case 'ArrowDown':
          e.preventDefault()
          if (features.length === 0) return
          setSelectedIndex((prev) => (prev < features.length - 1 ? prev + 1 : 0))
          break
        case 'Enter':
          e.preventDefault()
          features[selectedIndex]?.onClick?.()
          break
      }
    },
    [disabled, features, selectedIndex]
  )

  useImperativeHandle(ref, () => ({
    nextFeature() {
      if (features.length === 0) return
      setSelectedIndex((prev) => (prev < features.length - 1 ? prev + 1 : 0))
    },
    prevFeature() {
      if (features.length === 0) return
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : features.length - 1))
    },
    useFeature() {
      features[selectedIndex]?.onClick?.()
    },
    resetSelectedIndex() {
      setSelectedIndex(0)
    },
    focus() {
      containerRef.current?.focus()
    }
  }))

  return (
    <FocusContainer
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onFocus={() => {
        setIsFocused(true)
        onFocusChange?.(true)
      }}
      onBlur={() => {
        setIsFocused(false)
        onFocusChange?.(false)
      }}
      $focused={isFocused}>
      <FeatureList>
        <FeatureListWrapper>
          {features.map((feature, index) => (
            <Col span={24} key={feature.command.id}>
              <FeatureItem
                onClick={feature.onClick}
                className={index === selectedIndex ? 'active' : ''}
                $disabled={!!disabled}>
                <FeatureIcon>{feature.icon}</FeatureIcon>
                <FeatureTitle>{feature.title}</FeatureTitle>
                {index === selectedIndex && <EnterOutlined />}
              </FeatureItem>
            </Col>
          ))}
        </FeatureListWrapper>
      </FeatureList>
    </FocusContainer>
  )
}
FeatureMenus.displayName = 'FeatureMenus'

const FocusContainer = styled.div<{ $focused: boolean }>`
  outline: none;
  border-radius: 10px;

  /* A subtle focus state for keyboard navigation */
  box-shadow: ${({ $focused }) => ($focused ? '0 0 0 2px var(--color-primary-opacity)' : 'none')};
`

const FeatureList = styled(Scrollbar)`
  flex-shrink: 0;
  height: auto;
  -webkit-app-region: no-drag;
`

const FeatureListWrapper = styled.div`
  display: flex;
  flex-direction: column;
  gap: 5px;
  cursor: pointer;
`

const FeatureItem = styled.div<{ $disabled?: boolean }>`
  display: flex;
  flex-direction: row;
  cursor: ${({ $disabled }) => ($disabled ? 'not-allowed' : 'pointer')};
  transition: background-color 0s;
  background: transparent;
  border: none;
  padding: 8px 16px;
  display: flex;
  align-items: center;
  gap: 12px;
  -webkit-app-region: no-drag;
  border-radius: 8px;
  user-select: none;
  opacity: ${({ $disabled }) => ($disabled ? 0.6 : 1)};

  &:hover {
    background: var(--color-background-mute);
  }

  &.active {
    background: var(--color-background-mute);
  }
`

const FeatureIcon = styled.div`
  color: #fff;
  display: flex;
`

const FeatureTitle = styled.h3`
  margin: 0;
  font-size: 14px;
  flex-basis: 100%;
`

export default FeatureMenus
