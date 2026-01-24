import { useRuntime } from '@renderer/hooks/useRuntime'
import { Tooltip } from 'antd'
import { ListOrdered } from 'lucide-react'
import type { FC } from 'react'
import React from 'react'
import { useTranslation } from 'react-i18next'

import { NavbarIcon } from '../ChatNavbar'

interface Props {
  open: boolean
  onToggle: () => void
}

const MessagesTocButton: FC<Props> = ({ open, onToggle }) => {
  const { t } = useTranslation()
  const runtime = useRuntime()
  const isTopicMode = runtime.chat?.activeTopicOrSession === 'topic'

  if (!isTopicMode) return null

  return (
    <Tooltip title={t('chat.navigation.toc')} mouseEnterDelay={0.8}>
      <NavbarIcon onClick={onToggle} style={open ? { backgroundColor: 'var(--color-background-mute)' } : undefined}>
        <ListOrdered size={18} />
      </NavbarIcon>
    </Tooltip>
  )
}

export default React.memo(MessagesTocButton)
