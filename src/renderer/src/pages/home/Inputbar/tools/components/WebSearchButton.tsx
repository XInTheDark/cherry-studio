import { ActionIconButton } from '@renderer/components/Buttons'
import type { ToolQuickPanelController } from '@renderer/pages/home/Inputbar/types'
import { Tooltip } from 'antd'
import type { FC } from 'react'
import { memo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { useWebSearchPanelController, WebSearchProviderIcon } from './WebSearchQuickPanelManager'

interface Props {
  quickPanelController: ToolQuickPanelController
  assistantId: string
}

const WebSearchButton: FC<Props> = ({ quickPanelController, assistantId }) => {
  const { t } = useTranslation()
  const { enableWebSearch, toggleQuickPanel, selectedProviderId } = useWebSearchPanelController(
    assistantId,
    quickPanelController
  )

  const onClick = useCallback(() => {
    // When enabled, open the list so users can see (and change) the current selection,
    // instead of acting like a "close" toggle.
    toggleQuickPanel()
  }, [toggleQuickPanel])

  const ariaLabel = t('chat.input.web_search.label')

  return (
    <Tooltip placement="top" title={ariaLabel} mouseLeaveDelay={0} arrow>
      <ActionIconButton
        onClick={onClick}
        active={!!enableWebSearch}
        aria-label={ariaLabel}
        aria-pressed={!!enableWebSearch}>
        <WebSearchProviderIcon pid={selectedProviderId} />
      </ActionIconButton>
    </Tooltip>
  )
}

export default memo(WebSearchButton)
