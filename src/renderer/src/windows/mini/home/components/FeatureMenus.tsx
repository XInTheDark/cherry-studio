import { EnterOutlined } from '@ant-design/icons'
import Scrollbar from '@renderer/components/Scrollbar'
import { useAppSelector } from '@renderer/store'
import type { QuickAssistantCommand } from '@renderer/store/settings'
import { DEFAULT_QUICK_ASSISTANT_COMMANDS } from '@renderer/store/settings'
import { Col } from 'antd'
import { FileText, Languages, Lightbulb, MessageSquare } from 'lucide-react'
import { useImperativeHandle, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface FeatureMenusProps {
  text: string
  onUseCommand: (command: QuickAssistantCommand) => void
}

export interface FeatureMenusRef {
  nextFeature: () => void
  prevFeature: () => void
  useFeature: () => void
  resetSelectedIndex: () => void
}

const FeatureMenus = ({
  ref,
  text,
  onUseCommand
}: FeatureMenusProps & { ref?: React.RefObject<FeatureMenusRef | null> }) => {
  const { t } = useTranslation()
  const [selectedIndex, setSelectedIndex] = useState(0)

  const quickAssistantCommands =
    useAppSelector((state) => state.settings.quickAssistantCommands) || DEFAULT_QUICK_ASSISTANT_COMMANDS

  const features = useMemo(() => {
    const enabledCommands = (quickAssistantCommands || []).filter((c) => c.enabled)

    const getIcon = (type: QuickAssistantCommand['type']) => {
      switch (type) {
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
      icon: getIcon(command.type),
      title: command.titleKey ? t(command.titleKey) : command.title || '',
      onClick: () => {
        if (!text) return
        onUseCommand(command)
      }
    }))
  }, [onUseCommand, quickAssistantCommands, t, text])

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
    }
  }))

  return (
    <FeatureList>
      <FeatureListWrapper>
        {features.map((feature, index) => (
          <Col span={24} key={feature.command.id}>
            <FeatureItem onClick={feature.onClick} className={index === selectedIndex ? 'active' : ''}>
              <FeatureIcon>{feature.icon}</FeatureIcon>
              <FeatureTitle>{feature.title}</FeatureTitle>
              {index === selectedIndex && <EnterOutlined />}
            </FeatureItem>
          </Col>
        ))}
      </FeatureListWrapper>
    </FeatureList>
  )
}
FeatureMenus.displayName = 'FeatureMenus'

const FeatureList = styled(Scrollbar)`
  flex-shrink: 0;
  height: auto;
  -webkit-app-region: none;
`

const FeatureListWrapper = styled.div`
  display: flex;
  flex-direction: column;
  gap: 5px;
  cursor: pointer;
`

const FeatureItem = styled.div`
  display: flex;
  flex-direction: row;
  cursor: pointer;
  transition: background-color 0s;
  background: transparent;
  border: none;
  padding: 8px 16px;
  display: flex;
  align-items: center;
  gap: 12px;
  -webkit-app-region: none;
  border-radius: 8px;
  user-select: none;

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
